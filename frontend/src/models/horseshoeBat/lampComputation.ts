import type { DataFeature, ResultLayerEntry } from '@gsbio/engine';
import { wgs84ToBng, bngToWgs84LngLat } from '../../utils/projections';
import { ensureWasm, irradianceRun, irradianceToResistance, irradianceCombine } from '../../wasm/irradianceCompute';
import { fetchRaster } from '../../wasm/geotiffFetch';
import { rasterToPngDataUrl } from '../../wasm/rasterize';
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

function lampCoordToPixel(
  lng: number, lat: number,
  extent: { xmin: number; ymax: number; pixw: number },
): [number, number] {
  const [easting, northing] = wgs84ToBng(lat, lng);
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

function extractLampCoords(features: DataFeature[], extent: Extent): Float32Array | null {
  const coords: number[] = [];
  for (const f of features) {
    const gj = f.geojson as unknown as {
      type: string;
      geometry?: { type: string; coordinates: [number, number] };
    };
    if (!gj.geometry || gj.geometry.type !== 'Point' || !gj.geometry.coordinates) continue;
    const [lng, lat] = gj.geometry.coordinates;
    const [col, row] = lampCoordToPixel(lng, lat, extent);
    const height = (f.data?.height as number) ?? 0;
    coords.push(col, row, height);
  }
  if (coords.length === 0) return null;
  return new Float32Array(coords);
}

export async function computeLampsWasm(
  lampFeatures: DataFeature[],
  rawTifs: Record<string, string>,
  extent: Extent,
  params: Record<string, number>,
): Promise<{ totalRes: Float32Array; lampRes: Float32Array; extractedCount: number }> {
  await ensureWasm();

  const lampCoords = extractLampCoords(lampFeatures, extent);
  if (!lampCoords) {
    const zero = new Float32Array(extent.m * extent.n);
    return { totalRes: zero, lampRes: zero, extractedCount: 0 };
  }

  const keys = ['soft_surf', 'hard_surf', 'dtm', 'road_res', 'river_res', 'landscape_res', 'linear_res'] as const;
  const rasters: Record<string, Float32Array> = {};

  const results = await Promise.all(
    keys.map(async (k) => {
      const url = rawTifs[k];
      if (!url) return { k, data: new Float32Array(extent.m * extent.n) };
      const d = await fetchRaster(url);
      return { k, data: d.data };
    }),
  );
  for (const { k, data } of results) rasters[k] = data;

  const genericUrl = rawTifs['generic_res'];
  let genericData: Float32Array;
  if (genericUrl) {
    genericData = (await fetchRaster(genericUrl)).data;
  } else {
    genericData = new Float32Array(extent.m * extent.n);
  }

  const cutoff = params.lamp_ext ?? 100;

  const irradiance = irradianceRun(
    lampCoords,
    rasters['soft_surf'], rasters['hard_surf'], rasters['dtm'],
    extent.m, extent.n, extent.pixw, cutoff, 0, 0.5,
  );

  const lampRes = irradianceToResistance(
    irradiance, extent.m, extent.n,
    params.lamp_resmax ?? 1e8, params.lamp_xmax ?? 1,
  );

  const totalRes = irradianceCombine(
    lampRes,
    rasters['road_res'], rasters['river_res'], rasters['landscape_res'],
    rasters['linear_res'], genericData,
    extent.m, extent.n,
  );

  return { totalRes, lampRes, extractedCount: lampCoords.length / 3 };
}

export function buildLampResultLayers(
  totalRes: Float32Array,
  lampRes: Float32Array,
  extent: Extent,
): ResultLayerEntry[] {
  const bngExtent = [extent.xmin, extent.ymin, extent.xmax, extent.ymax] as const;
  const bounds = bngBoundsToWgs84(bngExtent);

  const layers: ResultLayerEntry[] = [];

  layers.push({
    id: 'lamp_res',
    name: 'Lamp Resistance',
    envelope: { kind: 'image', url: rasterToPngDataUrl(lampRes, extent.m, extent.n), bounds },
  });

  const logLampRes = new Float32Array(lampRes);
  for (let i = 0; i < logLampRes.length; i++) {
    logLampRes[i] = logLampRes[i] > 0 ? Math.log(logLampRes[i]) : 0;
  }
  layers.push({
    id: 'log_lamp_res',
    name: 'Log Lamp Resistance',
    envelope: { kind: 'image', url: rasterToPngDataUrl(logLampRes, extent.m, extent.n), bounds },
  });

  layers.push({
    id: 'total_res',
    name: 'Total Resistance',
    envelope: { kind: 'image', url: rasterToPngDataUrl(totalRes, extent.m, extent.n), bounds },
  });

  const logTotalRes = new Float32Array(totalRes);
  for (let i = 0; i < logTotalRes.length; i++) {
    logTotalRes[i] = logTotalRes[i] > 0 ? Math.log(logTotalRes[i]) : 0;
  }
  layers.push({
    id: 'log_total_res',
    name: 'Log Total Resistance',
    envelope: { kind: 'image', url: rasterToPngDataUrl(logTotalRes, extent.m, extent.n), bounds },
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
