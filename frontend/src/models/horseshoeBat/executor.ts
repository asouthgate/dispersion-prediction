import type {
  Executor,
  DataFeature,
  ResultLayerEntry,
  SimulationEngine,
} from '@gsbio/engine';
import type { PipelineStage } from './model';
import { horseshoeBatModel } from './model';
import { runPipelineJob } from './pipelineClient';
import { computeLampsWasm, buildLampResultLayers, encodeTotalResistance, type StoredTotalRes } from './lampComputation';

const LAMP_CATEGORIES = new Set(['Lights', 'LightSequence']);

let storedTotalRes: StoredTotalRes | null = null;

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
  lampFeatures: DataFeature[];
  params: Record<string, number>;
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
      const allFeatures = ctx.features;
      const nonLampFeatures = allFeatures.filter(f => !LAMP_CATEGORIES.has(f.category));
      const lampFeatures = allFeatures.filter(f => LAMP_CATEGORIES.has(f.category));
      return {
        payload: {
          stage: getStage(),
          roost,
          features: nonLampFeatures.map(featureToPayload),
          lampFeatures: lampFeatures as DataFeature[],
          params: { ...ctx.params },
        },
      };
    },

    async submit(ctx, signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { stage, roost, features, lampFeatures, params } = ctx.payload as PipelinePayload;

      ctx.onLog?.('info', `Starting ${stage} pipeline · ${features.length} features` +
        (lampFeatures.length > 0 ? ` · ${lampFeatures.length} lamp(s) (browser-side)` : ''));

      if (lampFeatures.length > 0) {
        ctx.onLog?.('info', 'Lamp irradiance resistance will be computed locally in your browser. Raw lamp positions are not sent to the server.');
      }

      const body: Record<string, unknown> = { roost, features, params };
      if (stage === 'current' && storedTotalRes) {
        body.total_resistance = encodeTotalResistance(storedTotalRes);
        ctx.onLog?.('info', 'Attaching browser-computed total resistance for Circuitscape');
      }

      const job = await runPipelineJob(stage, body, signal, {
        onLog: ctx.onLog,
        onProgress: ctx.onProgress,
      });

      console.debug('[executor] job result:', {
        status: job.status,
        layerIds: job.layers?.map(l => l.id),
        layerCount: job.layers?.length,
        rawTifsKeys: job.raw_tifs ? Object.keys(job.raw_tifs) : [],
        rawGeojsonKeys: job.raw_geojson ? Object.keys(job.raw_geojson) : [],
        rasterExtent: job.raster_extent,
      });

      if (job.status === 'cancelled') {
        return { layers: [] as ResultLayerEntry[], summary: { status: 'cancelled' } };
      }

      const replacedIds = new Set(['total_res', 'log_total_res']);
      let layers: ResultLayerEntry[] = (job.layers ?? [])
        .filter(l => !replacedIds.has(l.id))
        .map((l) => ({
          id: l.id,
          name: l.name,
          envelope: { kind: 'image' as const, url: l.url, bounds: l.bounds },
        }));

      if (stage === 'resistance' && job.raw_tifs && job.raster_extent) {
        ctx.onLog?.('info', `Computing resistance layers in browser via WebAssembly...`);

        try {
          const extent = job.raster_extent;
          const { totalRes, lampRes, coverageMask, extractedCount } = await computeLampsWasm(
            lampFeatures, job.raw_tifs, job.raw_geojson, extent, params,
            (fraction, label) => {
              ctx.onProgress?.({ step: 'submit', fraction: 0.95 + fraction * 0.05, label });
              ctx.onLog?.('info', label);
            },
          );
          layers.push(...(await buildLampResultLayers(totalRes, lampRes, coverageMask, extent)));
          storedTotalRes = { data: totalRes, extent };
          if (lampFeatures.length > 0) {
            ctx.onLog?.('info', `Lamp irradiance computed browser-side (${extractedCount} point(s)). Total resistance ready for Circuitscape.`);
          } else {
            ctx.onLog?.('info', 'Total resistance computed browser-side. Ready for Circuitscape.');
          }
        } catch (wasmErr) {
          const msg = wasmErr instanceof Error ? wasmErr.message : String(wasmErr);
          ctx.onLog?.('error', `Raster computation failed: ${msg}`);
          throw new Error(`Raster computation could not be completed in your browser: ${msg}`);
        }
      }

      ctx.onProgress?.({ step: 'submit', fraction: 1, label: `${layers.length} layers` });
      return { layers, summary: { stage, layerCount: layers.length }, taskId: job.job_id };
    },
  };
}

export function installHorseshoeBat(engine: SimulationEngine, getStage: () => PipelineStage): void {
  engine.registerModel(horseshoeBatModel);
  engine.registerExecutor(horseshoeBatModel.id, createHorseshoeBatExecutor(getStage));
  engine.setModel(horseshoeBatModel.id);
}
