import type {
  Executor,
  DataFeature,
  ResultLayerEntry,
  SimulationEngine,
  RasterPlotSpec,
} from '@gsbio/engine';
import { plotRaster } from '@gsbio/engine';
import type { PipelineStage } from './model';
import { horseshoeBatModel } from './model';
import { createPipelineAdapter } from './pipelineClient';
import { runRemoteJob } from '@gsbio/engine/remote';
import { fetchRaster } from '../../wasm/geotiffFetch';
import { ingestResistanceData, computeResistancePipeline, buildResistanceResultLayers, encodeTotalResistance, type StoredTotalRes } from './resistancePipeline';
import type { ResistanceParams } from '../../wasm/resistanceCompute';

const LAMP_CATEGORIES = new Set(['Lights', 'LightSequence']);

const RESISTANCE_CATEGORIES = new Set(['Road', 'River', 'Building', 'GenericResistance']);

const BROWSER_LAYER_IDS = new Set([
  'road_res', 'river_res', 'landscape_res', 'linear_res',
  'lamp_res', 'log_lamp_res', 'generic_res',
  'soft_surf', 'hard_surf',
  'total_res', 'log_total_res',
]);

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
  resistanceFeatures: DataFeature[];
  params: Record<string, number>;
}

function selectRoost(features: ReadonlyArray<DataFeature>): RoostInfo | null {
  for (const f of features) {
    if (f.category === 'Roost' && f.circle) {
      return { lng: f.circle.center.lng, lat: f.circle.center.lat, radiusMeters: f.circle.radiusMeters };
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

export function createHorseshoeBatExecutor(): Executor {
  return {
    async preprocess(ctx, signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const roost = selectRoost(ctx.features);
      if (!roost) {
        ctx.onLog?.('error', 'No Roost circle drawn: place a roost first.');
        throw new Error('No roost defined. Place a roost on the map first.');
      }
      const lampFeatures = ctx.features.filter(f => LAMP_CATEGORIES.has(f.category));
      const resistanceFeatures = ctx.features.filter(f => RESISTANCE_CATEGORIES.has(f.category));
      const nonLampFeatures = ctx.features.filter(f => !LAMP_CATEGORIES.has(f.category));
      return {
        payload: {
          stage: ctx.stage as PipelineStage,
          roost,
          features: nonLampFeatures.map(featureToPayload),
          lampFeatures: lampFeatures as DataFeature[],
          resistanceFeatures: resistanceFeatures as DataFeature[],
          params: { ...ctx.params },
        },
      };
    },

    async submit(ctx, signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { stage, roost, features, lampFeatures, resistanceFeatures, params } = ctx.payload as PipelinePayload;

      ctx.onLog?.('info', `Starting ${stage} pipeline · ${features.length} features` +
        (lampFeatures.length > 0 ? ` · ${lampFeatures.length} lamp(s) (browser-side)` : '') +
        (resistanceFeatures.length > 0 ? ` · ${resistanceFeatures.length} drawn (browser-side)` : ''));

      if (lampFeatures.length > 0 || resistanceFeatures.length > 0) {
        ctx.onLog?.('info', 'Resistance layers will be computed locally in your browser via WebAssembly.');
      }

      const body: Record<string, unknown> = { roost, features, params };
      const storedTotalRes = ctx.artifacts.get<StoredTotalRes>('total_resistance');
      if (stage === 'current' && storedTotalRes) {
        body.total_resistance = encodeTotalResistance(storedTotalRes);
        ctx.onLog?.('info', 'Attaching browser-computed total resistance for Circuitscape');
      }

      const job = await runRemoteJob(createPipelineAdapter(stage), body, signal, {
        onLog: ctx.onLog,
        onProgress: (fraction, label) => ctx.onProgress?.({ step: 'submit', fraction, label }),
        onStarted: (jobId) => ctx.onLog?.('info', `Job ${jobId} started`),
      });

      console.debug('[executor] job result:', {
        status: job.status,
        layerIds: job.status === 'completed' ? job.result.layers?.map((l) => l.id) : [],
        layerCount: job.status === 'completed' ? job.result.layers?.length : 0,
        rawTifsKeys: job.status === 'completed' ? Object.keys(job.result.raw_tifs ?? {}) : [],
        rawGeojsonKeys: job.status === 'completed' ? Object.keys(job.result.raw_geojson ?? {}) : [],
        rasterExtent: job.status === 'completed' ? job.result.raster_extent : undefined,
      });

      if (job.status === 'cancelled') {
        return { layers: [] as ResultLayerEntry[], summary: { status: 'cancelled' } };
      }

      const jobResult = job.result;

      const serverLayers = (jobResult.layers ?? []).filter(l => !BROWSER_LAYER_IDS.has(l.id));
      if (serverLayers.length > 0) {
        ctx.onLog?.('info', `Plotting ${serverLayers.length} raster layer(s) in your browser…`);
      }
      let layers: ResultLayerEntry[] = await Promise.all(
        serverLayers.map(async (l): Promise<ResultLayerEntry> => {
          const d = l.display ?? {};
          const raster = await fetchRaster(l.url);
          const nodata = typeof d.nodata === 'number' ? (d.nodata as number) : undefined;
          const spec: RasterPlotSpec = {
            palette: (d.palette as RasterPlotSpec['palette']) ?? 'magma',
            scale: d.scale as RasterPlotSpec['scale'],
            preTransformed: d.preTransformed as boolean | undefined,
            transform: d.transform as RasterPlotSpec['transform'],
            vmin: d.vmin as number | undefined,
            vmax: d.vmax as number | undefined,
            invert: d.invert as boolean | undefined,
            circularMask: d.circularMask as boolean | undefined,
            label: (d.label as string) ?? l.name,
            colorbar: { side: 'right' },
          };
          const out = await plotRaster(
            { data: raster.data, width: raster.n, height: raster.m, boundsWgs84: l.bounds, nodata },
            spec,
          );
          return {
            id: l.id,
            name: l.name,
            envelope: { kind: 'image', url: out.url, bounds: out.boundsWgs84 },
            raw: { filename: `${l.id}.tif`, url: l.url },
          };
        }),
      );

      if (stage === 'resistance' && jobResult.raw_tifs && jobResult.raster_extent) {
        ctx.onLog?.('info', 'Computing resistance layers in browser via WebAssembly...');

        try {
          const extent = jobResult.raster_extent;

          const rastParams: ResistanceParams = {
            road_buffer: params.road_buffer as number,
            road_resmax: params.road_resmax as number,
            road_xmax: params.road_xmax as number,
            river_buffer: params.river_buffer as number,
            river_resmax: params.river_resmax as number,
            river_xmax: params.river_xmax as number,
            landscape_rankmax: params.landscape_rankmax as number,
            landscape_resmax: params.landscape_resmax as number,
            landscape_xmax: params.landscape_xmax as number,
            linear_buffer: params.linear_buffer as number,
            linear_rankmax: params.linear_rankmax as number,
            linear_resmax: params.linear_resmax as number,
            linear_xmax: params.linear_xmax as number,
            lamp_resmax: params.lamp_resmax as number,
            lamp_xmax: params.lamp_xmax as number,
            lamp_ext: params.lamp_ext as number,
            pixw: extent.pixw,
            nrows: extent.m,
            ncols: extent.n,
          };

          const { pipelineInput, coverageMask, extractedLampCount } = await ingestResistanceData({
            rawTifs: jobResult.raw_tifs,
            rawGeojson: jobResult.raw_geojson,
            features: [...lampFeatures, ...resistanceFeatures],
            extent,
            params: rastParams,
            onProgress: (fraction, label) => {
              ctx.onProgress?.({ step: 'submit', fraction: 0.95 + fraction * 0.05, label });
              ctx.onLog?.('info', label);
            },
          });

          const pipelineResult = await computeResistancePipeline(pipelineInput);

          layers.push(...(await buildResistanceResultLayers(pipelineResult, coverageMask, extent)));
          ctx.artifacts.set<StoredTotalRes>('total_resistance', { data: pipelineResult.totalRes, extent });

          if (lampFeatures.length > 0) {
            ctx.onLog?.('info', `All resistance layers computed browser-side (${extractedLampCount} lamp point(s)). Total resistance ready for Circuitscape.`);
          } else {
            ctx.onLog?.('info', 'All resistance layers computed browser-side. Total resistance ready for Circuitscape.');
          }
        } catch (wasmErr) {
          const msg = wasmErr instanceof Error ? wasmErr.message : String(wasmErr);
          ctx.onLog?.('error', `Raster computation failed: ${msg}`);
          throw new Error(`Raster computation could not be completed in your browser: ${msg}`);
        }
      }

      ctx.onProgress?.({ step: 'submit', fraction: 1, label: `${layers.length} layers` });
      return { layers, summary: { stage, layerCount: layers.length }, taskId: jobResult.job_id };
    },
  };
}

export function installHorseshoeBat(engine: SimulationEngine): void {
  engine.registerModel(horseshoeBatModel);
  engine.registerExecutor(horseshoeBatModel.id, createHorseshoeBatExecutor());
  engine.setModel(horseshoeBatModel.id);
}
