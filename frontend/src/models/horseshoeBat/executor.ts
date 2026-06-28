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
  lamps: { x: number; y: number; z: number }[];
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

const METRES_PER_DEG_LAT = 111_320;

function approxMetres(dlat: number, dlon: number, midLat: number): number {
  const mPerDegLng = METRES_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);
  return Math.sqrt((dlat * METRES_PER_DEG_LAT) ** 2 + (dlon * mPerDegLng) ** 2);
}

function interpolateLineString(
  coords: [number, number][],
  height: number,
  spacing: number,
): { x: number; y: number; z: number }[] {
  const lamps: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const [lng1, lat1] = coords[i];
    const [lng2, lat2] = coords[i + 1];
    const dlon = lng2 - lng1;
    const dlat = lat2 - lat1;
    const midLat = (lat1 + lat2) / 2;
    const segLen = approxMetres(dlat, dlon, midLat);
    const nPts = Math.max(1, Math.floor(segLen / spacing));
    for (let pi = 1; pi <= nPts; pi++) {
      const t = pi / nPts;
      lamps.push({
        x: lng1 + t * dlon,
        y: lat1 + t * dlat,
        z: height,
      });
    }
  }
  return lamps;
}

/** Extract lamp coordinates from features tagged with category 'Lights'
 *  (Point features) and 'LightString' (LineString features interpolated
 *  at the feature's spacing interval). Coordinates are in WGS84 — the API
 *  backend converts WGS84 → BNG. */
function extractLamps(features: ReadonlyArray<DataFeature>): { x: number; y: number; z: number }[] {
  const lamps: { x: number; y: number; z: number }[] = [];

  for (const f of features) {
    if (f.category === 'Lights' && f.geometryKind === 'point') {
      const coords = (f.geojson.geometry as unknown as { coordinates: [number, number] }).coordinates;
      lamps.push({
        x: coords[0],
        y: coords[1],
        z: (f.data?.height as number) ?? (f.data?.z as number) ?? 0,
      });
    }

    if (f.category === 'LightString' && f.geometryKind === 'linestring') {
      const geom = f.geojson.geometry as unknown as { type: string; coordinates: [number, number][] };
      const height = (f.data?.height as number) ?? 0;
      const spacing = (f.data?.spacing as number) ?? 50;
      if (geom.coordinates && geom.coordinates.length >= 2) {
        lamps.push(...interpolateLineString(geom.coordinates, height, spacing));
      }
    }
  }

  return lamps;
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
      const features = ctx.features
        .filter((f) => f.category !== 'Lights' && f.category !== 'LightString')
        .map(featureToPayload);
      const lamps = extractLamps(ctx.features);
      const params = { ...ctx.params };
      return { payload: { stage: getStage(), roost, features, lamps, params } };
    },

    async submit(ctx, signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { stage, roost, features, lamps, params } = ctx.payload as PipelinePayload;

      ctx.onLog?.('info', `Starting ${stage} pipeline · ${features.length} features · ${lamps.length} lamps`);

      const startRes = await fetch(`${API_BASE}/pipeline/${stage}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roost, features, lamps, params }),
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
