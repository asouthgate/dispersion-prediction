import type { DataFeature, ResultLayerEntry } from '@gsbio/engine';
import { wgs84ToBng, bngToWgs84LngLat } from '../../utils/projections';
import { ensureResistanceWasm, runPipelineBrowser, rasterizeGeojson, type ResistanceParams, type ResistanceResult } from '../../wasm/resistanceCompute';
import { fetchRaster } from '../../wasm/geotiffFetch';
import { rasterToPngBlobUrl } from '../../wasm/rasterize';
import { fetchWithAuth } from '../../auth';

export type LogFn = (level: 'info' | 'warning' | 'error', message: string) => void;
export type ProgressFn = (fraction: number, label: string) => void;

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

type Extent = {
  m: number;
  n: number;
  pixw: number;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
};

const LAMP_CATEGORIES = new Set(['Lights', 'LightSequence']);
const RESISTANCE_CATEGORIES = new Set(['Road', 'River', 'Building', 'GenericResistance']);

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

function mergeGeojson(serverGj: string, browserGj: string): string {
  if (!browserGj) return serverGj;
  if (!serverGj) return browserGj;
  try {
    const server = JSON.parse(serverGj);
    const browser = JSON.parse(browserGj);
    server.features.push(...(browser.features ?? []));
    return JSON.stringify(server);
  } catch {
    return serverGj || browserGj;
  }
}

function projectCoordsToBng(coords: unknown): unknown {
  if (typeof (coords as number[])?.[0] === 'number' && typeof (coords as number[])?.[1] === 'number') {
    const [lng, lat] = coords as [number, number];
    const [easting, northing] = wgs84ToBng(lat, lng);
    return [easting, northing];
  }
  return (coords as unknown[]).map(projectCoordsToBng);
}

function featuresToGeojsonCollection(features: DataFeature[], layer: string): string {
  const geojsonFeatures = features.map(f => {
    const gj = (f.geojson ?? {}) as { geometry?: { type: string; coordinates: unknown } | undefined };
    const props: Record<string, unknown> = { layer, ...((f.data as Record<string, unknown>) ?? {}) };
    if (layer === 'buildings' && typeof props.height === 'number') {
      props.resistanceValue = props.height;
    }
    if (layer === 'generic_resistance' && typeof props.resistanceValue === 'number') {
      props.resistanceValue = props.resistanceValue;
    }
    const projectedGeom = gj?.geometry
      ? { type: gj.geometry.type, coordinates: projectCoordsToBng(gj.geometry.coordinates) }
      : null;
    return { type: 'Feature', geometry: projectedGeom, properties: props };
  });
  return JSON.stringify({ type: 'FeatureCollection', features: geojsonFeatures });
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

/**
 * The clean data bundle consumed by {@link computeResistancePipeline}.
 *
 * All rasters are passed as pre-fetched, pre-rasterized Float32Arrays.
 * Roads and rivers are binary masks (0 or 1). Buildings carries height
 * values (0 = no building, > 0 = building height in metres). Generic
 * resistance carries scalar resistance values. Lamps are [col, row, height_m,
 * ...] triples in pixel coordinates of the DTM/DSM grid.
 */
export interface ResistancePipelineInput {
  roads: Float32Array;
  rivers: Float32Array;
  buildings: Float32Array;
  genericResistance: Float32Array;
  dtm: Float32Array;
  dsm: Float32Array;
  landscapeConductance: Float32Array;
  lamps: Float32Array;
  /** All resistance parameters, fully populated. No defaults are applied. */
  params: ResistanceParams;
}

/**
 * Parameters for {@link ingestResistanceData} — everything needed to fetch
 * server data, merge it with user-drawn features, and rasterize into the
 * data bundle that the pipeline consumes.
 */
export interface DataIngestionInput {
  /** URL map returned by the server's resistance stage (keys: dtm, dsm, landscape_conductance). */
  rawTifs: Record<string, string>;
  /** URL map returned by the server (keys: roads, rivers, buildings, generic_resistance). */
  rawGeojson: Record<string, string> | undefined;
  /** All features on the map (roost, lamps, drawn resistance features). */
  features: DataFeature[];
  /** Raster extent in British National Grid coordinates. */
  extent: Extent;
  /** Fully populated resistance parameters. No defaults will be applied. */
  params: ResistanceParams;
  onProgress?: ProgressFn;
}

/**
 * Fetches server rasters and vectors, merges them with user-drawn features
 * (reprojecting drawn geometries from WGS84 to BNG), rasterizes all vector
 * layers, and returns a clean {@link ResistancePipelineInput} bundle ready
 * for the resistance computation.
 */
export async function ingestResistanceData(
  input: DataIngestionInput,
): Promise<{
  pipelineInput: ResistancePipelineInput;
  coverageMask: Uint8Array;
  extractedLampCount: number;
}> {
  const { rawTifs, rawGeojson, features, extent, params, onProgress } = input;

  await ensureResistanceWasm();
  const size = extent.m * extent.n;

  onProgress?.(0.05, 'Fetching DTM/DSM/Landscape conductance...');

  const rasterKeys = ['dtm', 'dsm', 'landscape_conductance'] as const;
  const rasters: Record<string, Float32Array> = {};

  const rasterResults = await Promise.all(
    rasterKeys.map(async (k) => {
      const url = rawTifs[k];
      if (!url) return { k, data: new Float32Array(size) };
      const d = await fetchRaster(url);
      return { k, data: d.data };
    }),
  );
  for (const { k, data } of rasterResults) {
    rasters[k] = data;
  }

  const coverageMask = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    coverageMask[i] = Number.isFinite(rasters['dtm'][i]) ? 1 : 0;
  }

  onProgress?.(0.12, 'Fetching vector features...');

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

  const drawnByLayer: Record<string, DataFeature[]> = {};
  const lampFeatures: DataFeature[] = [];

  for (const f of features) {
    if (LAMP_CATEGORIES.has(f.category)) {
      lampFeatures.push(f);
      continue;
    }
    if (!RESISTANCE_CATEGORIES.has(f.category)) continue;
    const cat = f.category.toLowerCase();
    const mapped = cat === 'genericresistance' ? 'generic_resistance' : cat === 'building' ? 'buildings' : cat;
    if (!drawnByLayer[mapped]) drawnByLayer[mapped] = [];
    drawnByLayer[mapped].push(f);
  }

  for (const name of gjNames) {
    const drawnGj = drawnByLayer[name]?.length ? featuresToGeojsonCollection(drawnByLayer[name], name) : '';
    geojsonLayers[name] = mergeGeojson(geojsonLayers[name] ?? '', drawnGj);
  }

  const emptyGeojson = JSON.stringify({ type: 'FeatureCollection', features: [] });
  const zeroRaster = new Float32Array(size);

  onProgress?.(0.20, 'Rasterizing road features...');

  const roadBinary = rasterizeGeojson(
    zeroRaster, extent.m, extent.n,
    geojsonLayers['roads'] ?? emptyGeojson,
    JSON.stringify({ roads: { resistance: 1.0, width: 0.0 } }),
    extent.xmin, extent.ymax, extent.pixw,
  ).resistanceMap;

  onProgress?.(0.30, 'Rasterizing river features...');

  const riverBinary = rasterizeGeojson(
    zeroRaster, extent.m, extent.n,
    geojsonLayers['rivers'] ?? emptyGeojson,
    JSON.stringify({ rivers: { resistance: 1.0, width: 0.0 } }),
    extent.xmin, extent.ymax, extent.pixw,
  ).resistanceMap;

  onProgress?.(0.40, 'Rasterizing building features...');

  const buildingMask = rasterizeGeojson(
    zeroRaster, extent.m, extent.n,
    geojsonLayers['buildings'] ?? emptyGeojson,
    JSON.stringify({ buildings: { resistance: 1.0, width: 0.0 } }),
    extent.xmin, extent.ymax, extent.pixw,
  ).resistanceMap;

  onProgress?.(0.50, 'Rasterizing generic resistance...');

  const genericRes = rasterizeGeojson(
    zeroRaster, extent.m, extent.n,
    geojsonLayers['generic_resistance'] ?? emptyGeojson,
    JSON.stringify({ generic_resistance: { resistance: 100.0, width: 0.0 } }),
    extent.xmin, extent.ymax, extent.pixw,
  ).resistanceMap;

  onProgress?.(0.55, 'Extracting lamp coordinates...');

  const lampCoords = extractLampCoords(lampFeatures, extent);
  const lamps = lampCoords ? lampCoords : new Float32Array(0);
  const extractedLampCount = lampCoords ? lampCoords.length / 3 : 0;

  return {
    pipelineInput: {
      roads: roadBinary,
      rivers: riverBinary,
      buildings: buildingMask,
      genericResistance: genericRes,
      dtm: rasters['dtm'],
      dsm: rasters['dsm'],
      landscapeConductance: rasters['landscape_conductance'],
      lamps,
      params,
    },
    coverageMask,
    extractedLampCount,
  };
}

/**
 * Runs the full resistance pipeline on the provided data bundle.
 *
 * This is a pure function with no side effects: all inputs are pre-fetched
 * and pre-rasterized. The caller is responsible for data ingestion via
 * {@link ingestResistanceData}.
 */
export function computeResistancePipeline(input: ResistancePipelineInput): ResistanceResult {
  const result = runPipelineBrowser(
    input.roads,
    input.rivers,
    input.buildings,
    input.dtm,
    input.dsm,
    input.genericResistance,
    input.lamps,
    input.landscapeConductance,
    input.params,
  );
  return result;
}

export function applyMask(data: Float32Array, mask: Uint8Array): Float32Array {
  const result = new Float32Array(data);
  for (let i = 0; i < result.length; i++) {
    if (mask[i] === 0) result[i] = NaN;
  }
  return result;
}

export async function buildResistanceResultLayers(
  result: ResistanceResult,
  coverageMask: Uint8Array,
  extent: Extent,
): Promise<ResultLayerEntry[]> {
  const bngExtent = [extent.xmin, extent.ymin, extent.xmax, extent.ymax] as const;
  const bounds = bngBoundsToWgs84(bngExtent);
  const { m, n } = extent;

  const layers: ResultLayerEntry[] = [];

  const addLayer = async (id: string, name: string, data: Float32Array) => {
    const masked = applyMask(data, coverageMask);
    layers.push({ id, name, envelope: { kind: 'image', url: await rasterToPngBlobUrl(masked, m, n), bounds } });
  };

  const addLogLayer = async (id: string, name: string, data: Float32Array) => {
    const logData = new Float32Array(data);
    for (let i = 0; i < logData.length; i++) {
      logData[i] = Number.isNaN(logData[i]) ? NaN : (logData[i] > 0 ? Math.log(logData[i]) : 0);
    }
    const masked = applyMask(logData, coverageMask);
    layers.push({ id, name, envelope: { kind: 'image', url: await rasterToPngBlobUrl(masked, m, n), bounds } });
  };

  await Promise.all([
    addLayer('road_res', 'Road Resistance', result.roadRes),
    addLayer('river_res', 'River Resistance', result.riverRes),
    addLayer('linear_res', 'Linear Resistance', result.linearRes),
    addLayer('lamp_res', 'Lamp Resistance', result.lampRes),
    addLogLayer('log_lamp_res', 'Log Lamp Resistance', result.lampRes),
    addLayer('generic_res', 'Generic Resistance', result.genericRes),
    addLayer('soft_surf', 'Soft Surface', result.softSurf),
    addLayer('hard_surf', 'Hard Surface', result.hardSurf),
    addLayer('total_res', 'Total Resistance', result.totalRes),
    addLayer('landscape_res', 'Landscape Resistance', result.landscapeRes),
    addLogLayer('log_total_res', 'Log Total Resistance', result.totalRes),
  ]);

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
