import type { DataFeature, ResultLayerEntry } from '@gsbio/engine';
import { wgs84ToBng, bngToWgs84LngLat } from '../../utils/projections';
import { ensureResistanceWasm, runPipeline, rasterizeGeojson, type ResistanceParams } from '../../wasm/resistanceCompute';
import { fetchRaster } from '../../wasm/geotiffFetch';
import { rasterToPngBlobUrl } from '../../wasm/rasterize';
import { fetchWithAuth } from '../../auth';
import type { JobStatus } from './pipelineClient';

export interface StoredTotalRes {
  data: Float32Array;
  extent: {
    m: number;
    n: number;
    pixw: number;
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
  };
}

type Extent = NonNullable<JobStatus['raster_extent']>;

function bngToPixel(
  easting: number, northing: number,
  extent: { xmin: number; ymax: number; pixw: number },
): [number, number] {
  const col = (easting - extent.xmin) / extent.pixw;
  const row = (extent.ymax - northing) / extent.pixw;
  return [col, row];
}

function bngBoundsToWgs84(
  [xmin, ymin, xmax, ymax]: readonly [number, number, number, number],
): [number, number, number, number] {
  const [west, south] = bngToWgs84LngLat(xmin, ymin);
  const [east, north] = bngToWgs84LngLat(xmax, ymax);
  return [west, south, east, north];
}

async function fetchGeojson(url: string): Promise<string> {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

export function extractLampCoords(features: DataFeature[], extent: Extent): Float32Array | null {
  const coords: number[] = [];
  for (const f of features) {
    const gj = f.geojson as unknown as {
      type: string;
      geometry?: { type: string; coordinates: unknown };
    };
    const geom = gj?.geometry;
    if (!geom) continue;
    const height = (f.data?.height as number) ?? 0;

    if (geom.type === 'Point') {
      const [lng, lat] = geom.coordinates as [number, number];
      const [easting, northing] = wgs84ToBng(lat, lng);
      const [col, row] = bngToPixel(easting, northing, extent);
      coords.push(col, row, height);
    } else if (geom.type === 'LineString') {
      const spacing = (f.data?.spacing as number) ?? 50;
      const ring = geom.coordinates as [number, number][];
      for (let i = 0; i < ring.length - 1; i++) {
        const [e1, n1] = wgs84ToBng(ring[i][1], ring[i][0]);
        const [e2, n2] = wgs84ToBng(ring[i + 1][1], ring[i + 1][0]);
        const dx = e2 - e1;
        const dy = n2 - n1;
        const segLen = Math.sqrt(dx * dx + dy * dy);
        const nPoints = Math.max(1, Math.floor(segLen / spacing));
        for (let p = 1; p <= nPoints; p++) {
          const t = p / nPoints;
          const [col, row] = bngToPixel(e1 + t * dx, n1 + t * dy, extent);
          coords.push(col, row, height);
        }
      }
    }
  }
  if (coords.length === 0) return null;
  return new Float32Array(coords);
}

export async function computeLampsWasm(
  lampFeatures: DataFeature[],
  rawTifs: Record<string, string>,
  rawGeojson: Record<string, string> | undefined,
  extent: Extent,
  params: Record<string, number>,
): Promise<{ totalRes: Float32Array; lampRes: Float32Array; coverageMask: Uint8Array; extractedCount: number }> {
  await ensureResistanceWasm();

  const size = extent.m * extent.n;

  const rasterKeys = ['dtm', 'dsm', 'lcm'] as const;
  const rasters: Record<string, Float32Array> = {};

  const rasterResults = await Promise.all(
    rasterKeys.map(async (k) => {
      const url = rawTifs[k];
      if (!url) return { k, data: new Float32Array(size) };
      const d = await fetchRaster(url);
      return { k, data: d.data };
    }),
  );
  for (const { k, data } of rasterResults) rasters[k] = data;

  console.debug('[computeLampsWasm] extent:', JSON.stringify(extent));
  console.debug('[computeLampsWasm] raster dims:', rasters['dtm'].length, 'expected:', extent.m * extent.n);
  console.debug('[computeLampsWasm] raster pixels valid (dtm):', rasters['dtm'].filter(v => Number.isFinite(v)).length);
  console.debug('[computeLampsWasm] rawTifs keys:', Object.keys(rawTifs));
  console.debug('[computeLampsWasm] rawGeojson keys:', rawGeojson ? Object.keys(rawGeojson) : []);

  const coverageMask = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    coverageMask[i] = Number.isFinite(rasters['dtm'][i]) ? 1 : 0;
  }

  const geojsonLayers: Record<string, string> = {};
  const gjNames = ['roads', 'rivers', 'buildings', 'generic_resistance'] as const;

  if (rawGeojson) {
    await Promise.all(
      gjNames.map(async (name) => {
        const url = rawGeojson[name];
        if (url) {
          geojsonLayers[name] = await fetchGeojson(url);
        }
      }),
    );
  }

  console.debug('[computeLampsWasm] geojson fetched:', Object.keys(geojsonLayers).filter(k => geojsonLayers[k] && geojsonLayers[k].length > 100));

  const emptyGeojson = JSON.stringify({ type: 'FeatureCollection', features: [] });
  const zeroRaster = new Float32Array(size);

  const roadBinary = rasterizeGeojson(
    zeroRaster, extent.m, extent.n,
    geojsonLayers['roads'] ?? emptyGeojson,
    JSON.stringify({ roads: { resistance: 1.0, width: 0.0 } }),
    extent.xmin, extent.ymax, extent.pixw,
  ).resistanceMap;

  const riverBinary = rasterizeGeojson(
    zeroRaster, extent.m, extent.n,
    geojsonLayers['rivers'] ?? emptyGeojson,
    JSON.stringify({ rivers: { resistance: 1.0, width: 0.0 } }),
    extent.xmin, extent.ymax, extent.pixw,
  ).resistanceMap;

  const buildingMask = rasterizeGeojson(
    zeroRaster, extent.m, extent.n,
    geojsonLayers['buildings'] ?? emptyGeojson,
    JSON.stringify({ buildings: { resistance: 1.0, width: 0.0 } }),
    extent.xmin, extent.ymax, extent.pixw,
  ).resistanceMap;

  const genericRes = rasterizeGeojson(
    zeroRaster, extent.m, extent.n,
    geojsonLayers['generic_resistance'] ?? emptyGeojson,
    JSON.stringify({ generic_resistance: { resistance: 100.0, width: 0.0 } }),
    extent.xmin, extent.ymax, extent.pixw,
  ).resistanceMap;

  console.debug('[computeLampsWasm] roadBinary non-zero:', roadBinary.filter(v => v > 0).length);
  console.debug('[computeLampsWasm] riverBinary non-zero:', riverBinary.filter(v => v > 0).length);
  console.debug('[computeLampsWasm] buildingMask non-zero:', buildingMask.filter(v => v > 0).length);
  console.debug('[computeLampsWasm] genericRes non-zero:', genericRes.filter(v => v > 0).length);

  const lampCoords = extractLampCoords(lampFeatures, extent);
  let lamps: Float32Array;
  let extractedCount = 0;

  if (lampCoords) {
    extractedCount = lampCoords.length / 3;
    lamps = lampCoords;
  } else {
    lamps = new Float32Array(0);
  }

  const rastParams: ResistanceParams = {
    road_buffer: params.road_buffer ?? 200,
    road_resmax: params.road_resmax ?? 10,
    road_xmax: params.road_xmax ?? 5,
    river_buffer: params.river_buffer ?? 10,
    river_resmax: params.river_resmax ?? 2000,
    river_xmax: params.river_xmax ?? 4,
    landscape_rankmax: params.landscape_rankmax ?? 8,
    landscape_resmax: params.landscape_resmax ?? 100,
    landscape_xmax: params.landscape_xmax ?? 5,
    linear_buffer: params.linear_buffer ?? 10,
    linear_rankmax: params.linear_rankmax ?? 4,
    linear_resmax: params.linear_resmax ?? 22000,
    linear_xmax: params.linear_xmax ?? 3,
    lamp_resmax: params.lamp_resmax ?? 1e8,
    lamp_xmax: params.lamp_xmax ?? 1,
    lamp_ext: params.lamp_ext ?? 100,
    pixw: extent.pixw,
    nrows: extent.m,
    ncols: extent.n,
  };

  const pipelineResult = runPipeline(
    roadBinary,
    riverBinary,
    buildingMask,
    rasters['lcm'],
    rasters['dtm'],
    rasters['dsm'],
    genericRes,
    lamps,
    rastParams,
  );

  console.debug('[computeLampsWasm] pipeline result:', {
    totalRes: { len: pipelineResult.totalRes.length, nonZeroFinite: pipelineResult.totalRes.filter(v => v > 0 && Number.isFinite(v)).length },
    lampRes: { len: pipelineResult.lampRes.length, nonZeroFinite: pipelineResult.lampRes.filter(v => v > 0 && Number.isFinite(v)).length },
    roadRes: { nonZeroFinite: pipelineResult.roadRes.filter(v => v > 0 && Number.isFinite(v)).length },
    riverRes: { nonZeroFinite: pipelineResult.riverRes.filter(v => v > 0 && Number.isFinite(v)).length },
    landscapeRes: { nonZeroFinite: pipelineResult.landscapeRes.filter(v => v > 0 && Number.isFinite(v)).length },
    linearRes: { nonZeroFinite: pipelineResult.linearRes.filter(v => v > 0 && Number.isFinite(v)).length },
    genericRes: { nonZeroFinite: pipelineResult.genericRes.filter(v => v > 0 && Number.isFinite(v)).length },
    softSurf: { nonZeroFinite: pipelineResult.softSurf.filter(v => v > 0 && Number.isFinite(v)).length },
    hardSurf: { nonZeroFinite: pipelineResult.hardSurf.filter(v => v > 0 && Number.isFinite(v)).length },
    nrows: pipelineResult.nrows, ncols: pipelineResult.ncols,
  });

  return {
    totalRes: pipelineResult.totalRes,
    lampRes: pipelineResult.lampRes,
    coverageMask,
    extractedCount,
  };
}

export function applyMask(data: Float32Array, mask: Uint8Array): Float32Array {
  const result = new Float32Array(data);
  for (let i = 0; i < result.length; i++) {
    if (mask[i] === 0) result[i] = NaN;
  }
  return result;
}

export async function buildLampResultLayers(
  totalRes: Float32Array,
  lampRes: Float32Array,
  coverageMask: Uint8Array,
  extent: Extent,
): Promise<ResultLayerEntry[]> {
  const bngExtent = [extent.xmin, extent.ymin, extent.xmax, extent.ymax] as const;
  const bounds = bngBoundsToWgs84(bngExtent);

  const maskedLampRes = applyMask(lampRes, coverageMask);
  const maskedTotalRes = applyMask(totalRes, coverageMask);

  const layers: ResultLayerEntry[] = [];

  layers.push({
    id: 'lamp_res',
    name: 'Lamp Resistance',
    envelope: { kind: 'image', url: await rasterToPngBlobUrl(maskedLampRes, extent.m, extent.n), bounds },
  });

  const logLampRes = new Float32Array(maskedLampRes);
  for (let i = 0; i < logLampRes.length; i++) {
    logLampRes[i] = Number.isNaN(logLampRes[i]) ? NaN
      : (logLampRes[i] > 0 ? Math.log(logLampRes[i]) : 0);
  }
  layers.push({
    id: 'log_lamp_res',
    name: 'Log Lamp Resistance',
    envelope: { kind: 'image', url: await rasterToPngBlobUrl(logLampRes, extent.m, extent.n), bounds },
  });

  layers.push({
    id: 'total_res',
    name: 'Total Resistance',
    envelope: { kind: 'image', url: await rasterToPngBlobUrl(maskedTotalRes, extent.m, extent.n), bounds },
  });

  const logTotalRes = new Float32Array(maskedTotalRes);
  for (let i = 0; i < logTotalRes.length; i++) {
    logTotalRes[i] = Number.isNaN(logTotalRes[i]) ? NaN
      : (logTotalRes[i] > 0 ? Math.log(logTotalRes[i]) : 0);
  }
  layers.push({
    id: 'log_total_res',
    name: 'Log Total Resistance',
    envelope: { kind: 'image', url: await rasterToPngBlobUrl(logTotalRes, extent.m, extent.n), bounds },
  });

  return layers;
}

export function encodeTotalResistance(res: StoredTotalRes): {
  extent: StoredTotalRes['extent'];
  data_base64: string;
} {
  const bytes = new Uint8Array(res.data.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { extent: res.extent, data_base64: btoa(binary) };
}
