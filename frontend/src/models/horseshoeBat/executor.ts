import type {
  Executor,
  DataFeature,
  ResultLayerEntry,
  SimulationEngine,
} from '@gsbio/engine';
import type { PipelineStage } from './model';
import { horseshoeBatModel } from './model';

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
  layers?: { id: string; url: string; bounds: [number, number, number, number] }[];
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

      const startRes = await fetch(`${API_BASE}/pipeline/${stage}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roost, features, params }),
        signal,
      });
      if (!startRes.ok) throw new Error(`Failed to start pipeline: ${startRes.status}`);
      const { job_id } = (await startRes.json()) as { job_id: string };
      ctx.onLog?.('info', `Job ${job_id} started`);

      const POLL_INTERVAL_MS = 2000;
      const MAX_POLLS = 300;

      const onAbort = () => {
        fetch(`${API_BASE}/pipeline/${job_id}`, { method: 'DELETE' }).catch(() => {});
      };
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        let job: JobStatus = { job_id, status: 'pending', progress: 0, progress_label: '', error: null, warnings: [] };
        for (let poll = 0; poll < MAX_POLLS; poll++) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          await delay(POLL_INTERVAL_MS, signal);
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const res = await fetch(`${API_BASE}/pipeline/${job_id}`, { signal });
          if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
          job = (await res.json()) as JobStatus;
          ctx.onProgress?.({ step: 'submit', fraction: job.progress, label: job.progress_label });
          if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') break;
        }
        if (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled') {
          throw new Error('Pipeline timed out — it took longer than expected. Try a smaller area or contact support.');
        }

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
          envelope: { kind: 'image' as const, url: l.url, bounds: l.bounds },
        }));

        for (const w of job.warnings ?? []) {
          ctx.onLog?.('warning', w);
        }

        ctx.onProgress?.({ step: 'submit', fraction: 1, label: `${layers.length} layers` });
        return { layers, summary: { stage, layerCount: layers.length } };
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
