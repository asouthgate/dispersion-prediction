import type {
  Executor,
  DataFeature,
  ResultLayerEntry,
  SimulationEngine,
  RasterPlotSpec,
  SubmitContext,
} from '@gsbio/engine';
import { plotRaster, alignRasterToGrid, encodeGeoTiff } from '@gsbio/engine';
import { createPipelineAdapter } from '../horseshoeBat/pipelineClient';
import { runRemoteJob } from '@gsbio/engine/remote';
import {
  ingestResistanceData,
  computeResistancePipeline,
  applyMask,
} from '../horseshoeBat/resistancePipeline';
import { LIGHTMAP_CATEGORY, type LightMapData } from '../horseshoeBat/lightMap';
import type { ResistanceParams } from '../../wasm/resistanceCompute';
import { wgs84ToBng } from '../../utils/projections';
import { solveConnectivity, type ConnectivitySolveResult } from '../../wasm/connectivityCompute';
import { darkCorridorsModel } from './model';
import { currentQuantiles } from '../../wasm/currentQuantiles';
import { JET_COLORS } from '../../../wasm-connectivity/example/src/render.js';

const LAMP_CATEGORIES = new Set(['Lights', 'LightSequence']);

interface RoostInfo {
  lng: number;
  lat: number;
  radiusMeters: number;
}

interface DarkPayload {
  roost: RoostInfo;
  lampFeatures: DataFeature[];
  lightMapFeature: DataFeature | null;
  params: Record<string, number>;
}

interface Extent {
  m: number;
  n: number;
  pixw: number;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
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

async function runResistanceJob(ctx: SubmitContext, body: unknown, signal: AbortSignal) {
  return runRemoteJob(createPipelineAdapter('resistance'), body, signal, {
    onLog: ctx.onLog,
    onProgress: (fraction, label) => ctx.onProgress?.({ step: 'submit', fraction, label }),
    onStarted: (jobId) => ctx.onLog?.('info', `Job ${jobId} started`),
  });
}

function buildSourceAndGround(
  roost: RoostInfo,
  extent: Extent,
  nCircles: number,
): { source: Float32Array; ground: Float32Array } {
  const [easting, northing] = wgs84ToBng(roost.lat, roost.lng);
  const { m, n, pixw, xmin, ymax } = extent;
  const size = m * n;
  const source = new Float32Array(size);
  const ground = new Float32Array(size);

  const roostCol = Math.floor((easting - xmin) / pixw);
  const roostRow = Math.floor((ymax - northing) / pixw);
  const radiusCells = roost.radiusMeters / pixw;
  const lb = Math.max(radiusCells / Math.max(nCircles, 1), 1.0);

  let r = lb;
  while (r <= radiusCells) {
    const nPts = Math.max(Math.floor(3.0 * r), 10);
    for (let i = 0; i < nPts; i++) {
      const angle = (2.0 * Math.PI * i) / nPts;
      const col = Math.floor(roostCol + r * Math.sin(angle));
      const row = Math.floor(roostRow + r * Math.cos(angle));
      if (col >= 0 && col < n && row >= 0 && row < m) {
        source[row * n + col] = 1.0;
      }
    }
    r += lb;
  }

  const gc = Math.floor(roostCol);
  const gr = Math.floor(roostRow);
  if (gc >= 0 && gc < n && gr >= 0 && gr < m) {
    ground[gr * n + gc] = 1.0;
  }

  return { source, ground };
}

async function buildDarkCorridorsLayers(
  lampRes: Float32Array,
  solveResult: ConnectivitySolveResult,
  extent: Extent,
): Promise<ResultLayerEntry[]> {
  const { m, n, xmin, ymin, xmax, ymax } = extent;
  const bngExtent: [number, number, number, number] = [xmin, ymin, xmax, ymax];

  const mask = new Uint8Array(lampRes.length);
  for (let i = 0; i < lampRes.length; i++) {
    mask[i] = Number.isFinite(lampRes[i]) ? 1 : 0;
  }

  const layers: ResultLayerEntry[] = [];
  const addLayer = async (
    id: string,
    name: string,
    data: Float32Array,
    label: string,
    circularMask: boolean,
  ) => {
    const masked = applyMask(data, mask);
    const grid = { data: currentQuantiles(masked), width: n, height: m, crs: 'EPSG:27700' as const, bounds: bngExtent };
    const spec: RasterPlotSpec = {
      palette: JET_COLORS, scale: 'linear', label, circularMask, colorbar: { side: 'right' },
      vmin: 0, vmax: 100, alphaCutoff: 0.25,
    };
    const plotted = await plotRaster(grid, spec);
    const alphaPlotted = await plotRaster(grid, { ...spec, alphaRamp: true });
    const tif = new Uint8Array(encodeGeoTiff({ data: masked, width: n, height: m }, { bounds: bngExtent }));
    layers.push({
      id,
      name,
      envelope: { kind: 'image', url: plotted.url, bounds: plotted.boundsWgs84 },
      envelopeMasked: { kind: 'image', url: alphaPlotted.url, bounds: alphaPlotted.boundsWgs84 },
      raw: { filename: `${id}.tif`, bytes: tif },
    });
  };

  await addLayer('lamp_res', 'Lamp resistance', lampRes, 'Lamp resistance percentile (%)', false);
  await addLayer('darkness_current', 'Darkness current', solveResult.current, 'Current percentile (%)', true);

  return layers;
}

export function createDarkCorridorsExecutor(): Executor {
  return {
    async preprocess(ctx, signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const roost = selectRoost(ctx.features);
      if (!roost) {
        ctx.onLog?.('error', 'No Roost circle drawn: place a roost first.');
        throw new Error('No roost defined. Place a roost on the map first.');
      }
      const lampFeatures = ctx.features.filter((f) => LAMP_CATEGORIES.has(f.category));
      const lightMapFeature = findLightMapFeature(ctx.features);

      if (lampFeatures.length > 0 && lightMapFeature) {
        ctx.onLog?.('error', 'Provide either lamp points (Lighting) or a light map, not both.');
        throw new Error('Provide either lamp points or a light map, not both.');
      }
      if (lampFeatures.length === 0 && !lightMapFeature) {
        ctx.onLog?.('error', 'No lighting loaded: import lamp points or a light map first.');
        throw new Error('Import lamp points or a light map first.');
      }

      return {
        payload: {
          roost,
          lampFeatures,
          lightMapFeature,
          params: { ...ctx.params },
        },
      };
    },

    async submit(ctx, signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { roost, lampFeatures, lightMapFeature, params } = ctx.payload as DarkPayload;
      const lightMap = lightMapData(lightMapFeature);

      ctx.onLog?.('info', 'Fetching terrain data for lighting resistance…');
      const job = await runResistanceJob(ctx, { roost, features: [], params }, signal);
      if (job.status === 'cancelled') {
        return { layers: [] as ResultLayerEntry[], summary: { status: 'cancelled' } };
      }
      const jobResult = job.result;
      if (!jobResult.raw_tifs || !jobResult.raster_extent) {
        throw new Error('Resistance pipeline returned no rasters to compute locally.');
      }

      const extent = jobResult.raster_extent;

      const rastParams: ResistanceParams = {
        road_buffer: 0,
        road_resmax: 1,
        road_xmax: 1,
        river_buffer: 0,
        river_resmax: 1,
        river_xmax: 1,
        landscape_rankmax: 1,
        landscape_resmax: 1,
        landscape_xmax: 1,
        linear_buffer: 0,
        linear_rankmax: 1,
        linear_resmax: 1,
        linear_xmax: 1,
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

      ctx.onLog?.('info', 'Computing lighting resistance in browser via WebAssembly…');

      const { pipelineInput } = await ingestResistanceData({
        rawTifs: jobResult.raw_tifs,
        rawGeojson: jobResult.raw_geojson,
        features: lampFeatures,
        extent,
        params: rastParams,
        lightmap,
        onProgress: (fraction, label) => {
          ctx.onProgress?.({ step: 'submit', fraction: 0.9 * fraction, label });
          ctx.onLog?.('info', label);
        },
      });

      ctx.onProgress?.({ step: 'submit', fraction: 0.9, label: 'Computing lighting resistance (WebAssembly)...' });
      ctx.onLog?.('info', 'Computing lighting resistance (WebAssembly)...');
      const result = await computeResistancePipeline(pipelineInput);
      // Lamp resistance is an additive light penalty: zero means darkness,
      // not a missing/insulating cell. Keep a conductive background everywhere
      // terrain is valid, without adding any landscape/road/river resistance.
      const lampRes = Float32Array.from(result.lampRes, value => Number.isFinite(value) ? 1 + value : NaN);

      ctx.onLog?.('info', 'Solving darkness connectivity in browser via WebAssembly (multigrid CG)…');
      ctx.onProgress?.({ step: 'submit', fraction: 0.95, label: 'Solving darkness connectivity (WebAssembly)...' });
      const nCircles = Math.round(params.n_circles as number) || 50;
      const { source, ground } = buildSourceAndGround(roost, extent, nCircles);
      const solveResult = await solveConnectivity(
        lampRes, extent.m, extent.n, -9999, source, ground,
      );
      if (solveResult.warning) ctx.onLog?.('warning', solveResult.warning);
      ctx.onLog?.('info', `Darkness connectivity complete (${solveResult.totalIters} iterations).`);

      ctx.onProgress?.({ step: 'submit', fraction: 0.99, label: 'Rendering darkness connectivity maps...' });
      ctx.onLog?.('info', 'Rendering darkness connectivity maps...');
      const layers = await buildDarkCorridorsLayers(lampRes, solveResult, extent);
      ctx.onProgress?.({ step: 'submit', fraction: 1, label: `${layers.length} layers` });
      return { layers, summary: { layerCount: layers.length } };
    },
  };
}

export function installDarkCorridors(engine: SimulationEngine): void {
  engine.registerModel(darkCorridorsModel);
  engine.registerExecutor(darkCorridorsModel.id, createDarkCorridorsExecutor());
}
