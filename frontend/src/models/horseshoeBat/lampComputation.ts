import type { DataFeature, ResultLayerEntry } from '@gsbio/engine';
import { wgs84ToBng, bngToWgs84LngLat } from '../../utils/projections';
import { ensureResistanceWasm } from '../../wasm/resistanceCompute';
import { compute_lamp_and_total } from '../../../wasm-connectivity/lib/wasm_connect.js';
import { fetchRaster } from '../../wasm/geotiffFetch';
import { rasterToPngBlobUrl } from '../../wasm/rasterize';
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

function f32ToF64(arr: Float32Array): Float64Array {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i];
  return out;
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
  extent: Extent,
  params: Record<string, number>,
): Promise<{ totalRes: Float32Array; lampRes: Float32Array; coverageMask: Uint8Array; extractedCount: number }> {
  await ensureResistanceWasm();

  const size = extent.m * extent.n;

  const keys = ['dtm', 'soft_surf', 'hard_surf', 'road_res', 'river_res', 'landscape_res', 'linear_res'] as const;
  const rasters: Record<string, Float32Array> = {};

  const results = await Promise.all(
    keys.map(async (k) => {
      const url = rawTifs[k];
      if (!url) return { k, data: new Float32Array(size) };
      const d = await fetchRaster(url);
      return { k, data: d.data };
    }),
  );
  for (const { k, data } of results) rasters[k] = data;

  const coverageMask = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    coverageMask[i] = Number.isFinite(rasters['dtm'][i]) ? 1 : 0;
  }

  const genericUrl = rawTifs['generic_res'];
  let genericData: Float32Array;
  if (genericUrl) {
    genericData = (await fetchRaster(genericUrl)).data;
  } else {
    genericData = new Float32Array(size);
  }

  const lampCoords = extractLampCoords(lampFeatures, extent);
  let lamps: Float64Array;
  let extractedCount = 0;

  if (lampCoords) {
    extractedCount = lampCoords.length / 3;
    lamps = f32ToF64(lampCoords);
  } else {
    lamps = new Float64Array(0);
  }

  const json = compute_lamp_and_total(
    lamps,
    f32ToF64(rasters['soft_surf']),
    f32ToF64(rasters['hard_surf']),
    f32ToF64(rasters['dtm']),
    f32ToF64(rasters['road_res']),
    f32ToF64(rasters['river_res']),
    f32ToF64(rasters['landscape_res']),
    f32ToF64(rasters['linear_res']),
    f32ToF64(genericData),
    extent.m, extent.n,
    extent.pixw,
    params.lamp_resmax ?? 1e8,
    params.lamp_xmax ?? 1,
    params.lamp_ext ?? 100,
  );

  const parsed = JSON.parse(json);

  return {
    totalRes: new Float32Array(parsed.total_res),
    lampRes: new Float32Array(parsed.lamp_res),
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
