import type {
  Executor,
  DataFeature,
  ResultLayerEntry,
  SimulationEngine,
  RasterPlotSpec,
  SubmitContext,
} from '@gsbio/engine';
import { plotRaster, alignRasterToGrid } from '@gsbio/engine';
import type { PipelineStage } from './model';
import { horseshoeBatModel } from './model';
import { createPipelineAdapter, type JobStatus } from './pipelineClient';
import { runRemoteJob } from '@gsbio/engine/remote';
import { fetchRaster } from '../../wasm/geotiffFetch';
import { ingestResistanceData, computeResistancePipeline, buildResistanceResultLayers, encodeTotalResistance, type StoredTotalRes } from './resistancePipeline';
import { LIGHTMAP_CATEGORY, type LightMapData } from './lightMap';
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
  lightMapFeature: DataFeature | null;
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

function findLightMapFeature(features: ReadonlyArray<DataFeature>): DataFeature | null {
  return features.find((f) => f.category === LIGHTMAP_CATEGORY) ?? null;
}

function lightMapData(feature: DataFeature | null | undefined): LightMapData | null {
  if (!feature) return null;
  const raster = feature.data?.raster as LightMapData | null | undefined;
  if (!raster || !raster.data || !raster.width || !raster.height) return null;
  return raster;
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

type ServerLayer = NonNullable<JobStatus['layers']>[number];

async function plotServerLayers(ctx: SubmitContext, layers: ServerLayer[]): Promise<ResultLayerEntry[]> {
  const serverLayers = layers.filter((l) => !BROWSER_LAYER_IDS.has(l.id));
  if (serverLayers.length > 0) {
    ctx.onLog?.('info', `Plotting ${serverLayers.length} raster layer(s) in your browser…`);
  }
  return Promise.all(
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
      const grid = { data: raster.data, width: raster.n, height: raster.m, crs: l.crs, bounds: l.bounds, nodata };
      const out = await plotRaster(grid, spec);
      const masked = await plotRaster(grid, { ...spec, alphaRamp: true });
      return {
        id: l.id,
        name: l.name,
        envelope: { kind: 'image', url: out.url, bounds: out.boundsWgs84 },
        envelopeMasked: { kind: 'image', url: masked.url, bounds: masked.boundsWgs84 },
        raw: { filename: `${l.id}.tif`, url: l.url },
      };
    }),
  );
}

async function runPipelineJob(ctx: SubmitContext, stage: PipelineStage, body: unknown, signal: AbortSignal) {
  return runRemoteJob(createPipelineAdapter(stage), body, signal, {
    onLog: ctx.onLog,
    onProgress: (fraction, label) => ctx.onProgress?.({ step: 'submit', fraction, label }),
    onStarted: (jobId) => ctx.onLog?.('info', `Job ${jobId} started`),
  });
}

interface ResistanceStageInputs {
  roost: RoostInfo;
  features: FeaturePayload[];
  lampFeatures: DataFeature[];
  resistanceFeatures: DataFeature[];
  lightMap: LightMapData | null;
  params: Record<string, number>;
}

type ResistanceStageResult =
  | { cancelled: true }
  | { cancelled: false; totalRes: StoredTotalRes; layers: ResultLayerEntry[]; taskId: string };

async function runResistanceStage(
  ctx: SubmitContext,
  signal: AbortSignal,
  inputs: ResistanceStageInputs,
): Promise<ResistanceStageResult> {
  const { roost, features, lampFeatures, resistanceFeatures, lightMap, params } = inputs;

  ctx.onLog?.('info', `Starting resistance pipeline · ${features.length} features` +
    (lampFeatures.length > 0 ? ` · ${lampFeatures.length} lamp(s) (browser-side)` : '') +
    (resistanceFeatures.length > 0 ? ` · ${resistanceFeatures.length} drawn (browser-side)` : '') +
    (lightMap ? ' · light map (browser-side)' : ''));

  if (lampFeatures.length > 0 || resistanceFeatures.length > 0 || lightMap) {
    ctx.onLog?.('info', 'Resistance layers will be computed locally in your browser via WebAssembly.');
  }

  const body: Record<string, unknown> = { roost, features, params };

  const job = await runPipelineJob(ctx, 'resistance', body, signal);

  if (job.status === 'cancelled') {
    return { cancelled: true };
  }

  const jobResult = job.result;

  const layers = await plotServerLayers(ctx, jobResult.layers ?? []);

  if (!jobResult.raw_tifs || !jobResult.raster_extent) {
    throw new Error('Resistance pipeline returned no rasters to compute locally.');
  }

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

    const lightmap = lightMap
      ? alignRasterToGrid(lightMap, {
          m: extent.m,
          n: extent.n,
          pixw: extent.pixw,
          xmin: extent.xmin,
          ymin: extent.ymin,
          xmax: extent.xmax,
          ymax: extent.ymax,
        })
      : undefined;

    const { pipelineInput, coverageMask, extractedLampCount } = await ingestResistanceData({
      rawTifs: jobResult.raw_tifs,
      rawGeojson: jobResult.raw_geojson,
      features: [...lampFeatures, ...resistanceFeatures],
      extent,
      params: rastParams,
      lightmap,
      onProgress: (fraction, label) => {
        ctx.onProgress?.({ step: 'submit', fraction: 0.95 + fraction * 0.05, label });
        ctx.onLog?.('info', label);
      },
    });

    const pipelineResult = await computeResistancePipeline(pipelineInput);

    layers.push(...(await buildResistanceResultLayers(pipelineResult, coverageMask, extent)));

    const totalRes: StoredTotalRes = { data: pipelineResult.totalRes, extent };
    ctx.artifacts.set<StoredTotalRes>('total_resistance', totalRes);

    if (lightmap) {
      ctx.onLog?.('info', 'All resistance layers computed browser-side from the imported light map. Total resistance ready for Circuitscape.');
    } else if (lampFeatures.length > 0) {
      ctx.onLog?.('info', `All resistance layers computed browser-side (${extractedLampCount} lamp point(s)). Total resistance ready for Circuitscape.`);
    } else {
      ctx.onLog?.('info', 'All resistance layers computed browser-side. Total resistance ready for Circuitscape.');
    }

    return { cancelled: false, totalRes, layers, taskId: jobResult.job_id };
  } catch (wasmErr) {
    const msg = wasmErr instanceof Error ? wasmErr.message : String(wasmErr);
    ctx.onLog?.('error', `Raster computation failed: ${msg}`);
    throw new Error(`Raster computation could not be completed in your browser: ${msg}`);
  }
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
      const lightMapFeature = findLightMapFeature(ctx.features);
      const nonLampFeatures = ctx.features.filter(f => !LAMP_CATEGORIES.has(f.category) && f.category !== LIGHTMAP_CATEGORY);

      if (lampFeatures.length > 0 && lightMapFeature) {
        ctx.onLog?.('error', 'Provide either lamp points (Lighting) or a light map, not both.');
        throw new Error('Provide either lamp points or a light map, not both.');
      }

      return {
        payload: {
          stage: ctx.stage as PipelineStage,
          roost,
          features: nonLampFeatures.map(featureToPayload),
          lampFeatures: lampFeatures as DataFeature[],
          resistanceFeatures: resistanceFeatures as DataFeature[],
          lightMapFeature,
          params: { ...ctx.params },
        },
      };
    },

    async submit(ctx, signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { stage, roost, features, lampFeatures, resistanceFeatures, lightMapFeature, params } = ctx.payload as PipelinePayload;
      const lightMap = lightMapData(lightMapFeature);

      if (!roost) {
        ctx.onLog?.('error', 'No roost defined.');
        throw new Error('No roost defined. Place a roost on the map first.');
      }

      if (stage === 'coverage') {
        const body: Record<string, unknown> = { roost, features, params };
        const job = await runPipelineJob(ctx, 'coverage', body, signal);
        if (job.status === 'cancelled') {
          return { layers: [] as ResultLayerEntry[], summary: { status: 'cancelled' } };
        }
        const layers = await plotServerLayers(ctx, job.result.layers ?? []);
        ctx.onProgress?.({ step: 'submit', fraction: 1, label: `${layers.length} layers` });
        return { layers, summary: { stage, layerCount: layers.length }, taskId: job.result.job_id };
      }

      if (stage === 'resistance') {
        const result = await runResistanceStage(ctx, signal, { roost, features, lampFeatures, resistanceFeatures, lightMap, params });
        if (result.cancelled) {
          return { layers: [] as ResultLayerEntry[], summary: { status: 'cancelled' } };
        }
        ctx.onProgress?.({ step: 'submit', fraction: 1, label: `${result.layers.length} layers` });
        return { layers: result.layers, summary: { stage, layerCount: result.layers.length }, taskId: result.taskId };
      }

      // stage === 'current': always (re)compute resistance at the current
      // resolution first, then run Circuitscape on that total resistance.
      const resistance = await runResistanceStage(ctx, signal, { roost, features, lampFeatures, resistanceFeatures, lightMap, params });
      if (resistance.cancelled) {
        return { layers: [] as ResultLayerEntry[], summary: { status: 'cancelled' } };
      }

      const body: Record<string, unknown> = {
        roost,
        features,
        params,
        total_resistance: encodeTotalResistance(resistance.totalRes),
      };
      ctx.onLog?.('info', 'Attaching browser-computed total resistance for Circuitscape');

      const job = await runPipelineJob(ctx, 'current', body, signal);
      if (job.status === 'cancelled') {
        return { layers: [] as ResultLayerEntry[], summary: { status: 'cancelled' } };
      }
      const layers = await plotServerLayers(ctx, job.result.layers ?? []);
      ctx.onProgress?.({ step: 'submit', fraction: 1, label: `${layers.length} layers` });
      return { layers, summary: { stage, layerCount: layers.length }, taskId: job.result.job_id };
    },
  };
}

export function installHorseshoeBat(engine: SimulationEngine): void {
  engine.registerModel(horseshoeBatModel);
  engine.registerExecutor(horseshoeBatModel.id, createHorseshoeBatExecutor());
  engine.setModel(horseshoeBatModel.id);
}
