import type {
  Executor,
  DataFeature,
  ResultLayerEntry,
  SimulationEngine,
} from '@gsbio/engine';
import type { PipelineStage } from './model';
import { horseshoeBatModel } from './model';
import { fetchWithAuth } from '../../auth';

const API_BASE = '/api';

interface RoostInfo {
  lng: number;
  lat: number;
  radiusMeters: number;
}

interface FeaturePayload {
  id: string;
  category: string;
  label: string;
  geometryKind: string;
  geojson: Record<string, unknown>;
  circle?: { center: { lng: number; lat: number }; radiusMeters: number };
  data?: Record<string, unknown>;
}

interface PipelinePayload {
  stage: PipelineStage;
  roost: RoostInfo | null;
  features: FeaturePayload[];
  params: Record<string, number>;
}

interface JobStatus {
  job_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  progress_label: string;
  error: string | null;
  warnings: string[];
  layers?: { id: string; name: string; url: string; bounds: [number, number, number, number] }[];
}

function selectRoost(features: ReadonlyArray<DataFeature>): RoostInfo | null {
  for (const f of features) {
    if (f.category === 'Roost' && f.circle) {
      return {
        lng: f.circle.center.lng,
        lat: f.circle.center.lat,
        radiusMeters: f.circle.radiusMeters,
      };
    }
  }
  return null;
}

function featureToPayload(f: DataFeature): FeaturePayload {
  return {
    id: f.id,
    category: f.category,
    label: f.label,
    geometryKind: f.geometryKind,
    geojson: f.geojson as unknown as Record<string, unknown>,
    circle: f.circle ? {
      center: { lng: f.circle.center.lng, lat: f.circle.center.lat },
      radiusMeters: f.circle.radiusMeters,
    } : undefined,
    data: f.data,
  };
}

export function createHorseshoeBatExecutor(getStage: () => PipelineStage): Executor {
  return {
    async preprocess(ctx, signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const roost = selectRoost(ctx.features);
      if (!roost) {
        ctx.onLog?.('error', 'No Roost circle drawn — place a roost first.');
        throw new Error('No roost defined. Place a roost on the map first.');
      }
      const features = ctx.features.map(featureToPayload);
      const params = { ...ctx.params };
      return { payload: { stage: getStage(), roost, features, params } };
    },

    async submit(ctx, signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { stage, roost, features, params } = ctx.payload as PipelinePayload;

      ctx.onLog?.('info', `Starting ${stage} pipeline · ${features.length} features`);

      const startRes = await fetchWithAuth(`${API_BASE}/pipeline/${stage}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roost, features, params }),
        signal,
      });
      if (!startRes.ok) {
        let detail = `HTTP ${startRes.status}`;
        try {
          const body = await startRes.json();
          if (body.detail) detail = body.detail;
        } catch {}
        throw new Error(`Failed to start pipeline: ${detail}`);
      }
      const { job_id } = (await startRes.json()) as { job_id: string };
      ctx.onLog?.('info', `Job ${job_id} started`);

      // Poll fast for 2 minutes, then back off to 5s. 60×2s + 360×5s ≈ 32min,
      // covering the server's 30min PIPELINE_TIMEOUT so long jobs aren't
      // reported as timed-out while still running.
      const POLL_INTERVAL_MS = 2000;
      const SLOW_POLL_AFTER = 60;
      const MAX_POLLS = 420;

      const onAbort = () => {
        fetchWithAuth(`${API_BASE}/pipeline/${job_id}`, { method: 'DELETE' }).catch(() => {});
      };
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        let job: JobStatus = { job_id, status: 'pending', progress: 0, progress_label: '', error: null, warnings: [] };
        let logOffset = 0;
        for (let poll = 0; poll < MAX_POLLS; poll++) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          await delay(poll < SLOW_POLL_AFTER ? POLL_INTERVAL_MS : 5000, signal);
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const [statusRes, logsRes] = await Promise.all([
            fetchWithAuth(`${API_BASE}/pipeline/${job_id}`, { signal }),
            fetchWithAuth(`${API_BASE}/pipeline/${job_id}/logs?offset=${logOffset}`, { signal }).catch(() => null),
          ]);
          if (!statusRes.ok) throw new Error(`Poll failed: ${statusRes.status}`);
          job = (await statusRes.json()) as JobStatus;

          if (logsRes?.ok) {
            const logs = await logsRes.json() as { lines: string[]; offset: number; has_more: boolean };
            for (const line of logs.lines) {
              const level = line.startsWith('stderr:') ? 'warning' : 'info';
              ctx.onLog?.(level, line);
            }
            logOffset = logs.offset;
          }

          ctx.onProgress?.({ step: 'submit', fraction: job.progress, label: job.progress_label });
          if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') break;
        }
        if (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled') {
          throw new Error('Pipeline timed out — it took longer than expected. Try a smaller area or contact support.');
        }

        // Fetch any remaining logs after completion
        try {
          const finalLogs = await fetchWithAuth(`${API_BASE}/pipeline/${job_id}/logs?offset=${logOffset}`, { signal: new AbortController().signal });
          if (finalLogs.ok) {
            const logs = await finalLogs.json() as { lines: string[] };
            for (const line of logs.lines) {
              ctx.onLog?.('info', line);
            }
          }
        } catch { /* best-effort */ }

        if (job.status === 'failed') {
          ctx.onLog?.('error', job.error ?? 'Pipeline failed');
          throw new Error(job.error ?? 'Pipeline failed');
        }
        if (job.status === 'cancelled') {
          ctx.onLog?.('warning', 'Job was cancelled');
          return { layers: [] as ResultLayerEntry[], summary: { status: 'cancelled' } };
        }

        const layers: ResultLayerEntry[] = (job.layers ?? []).map((l) => ({
          id: l.id,
          name: l.name,
          envelope: { kind: 'image' as const, url: l.url, bounds: l.bounds },
        }));

        for (const w of job.warnings ?? []) {
          ctx.onLog?.('warning', w);
        }

        ctx.onProgress?.({ step: 'submit', fraction: 1, label: `${layers.length} layers` });
        return { layers, summary: { stage, layerCount: layers.length }, taskId: job_id };
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    const onAbort = () => { clearTimeout(id); reject(new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    signal?.addEventListener('abort', () => clearTimeout(id), { once: true });
  });
}

export function installHorseshoeBat(engine: SimulationEngine, getStage: () => PipelineStage): void {
  engine.registerModel(horseshoeBatModel);
  engine.registerExecutor(horseshoeBatModel.id, createHorseshoeBatExecutor(getStage));
  engine.setModel(horseshoeBatModel.id);
}
