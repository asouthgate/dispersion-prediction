import {
  rasterizeGeojsonAsync,
  runResistancePipelineBrowserAsync,
  runResistancePipelineBrowserWithLightmapAsync,
} from '../../wasm-connectivity/lib/wasm.js';

function f32ToF64(arr: Float32Array): Float64Array {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i];
  return out;
}

function jsonArrayToF32Array(values: unknown): Float32Array {
  const arr = values as number[];
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i];
  return out;
}

export interface ResistanceParams {
  road_buffer: number;
  road_resmax: number;
  road_xmax: number;
  river_buffer: number;
  river_resmax: number;
  river_xmax: number;
  landscape_rankmax: number;
  landscape_resmax: number;
  landscape_xmax: number;
  linear_buffer: number;
  linear_rankmax: number;
  linear_resmax: number;
  linear_xmax: number;
  lamp_resmax: number;
  lamp_xmax: number;
  lamp_ext: number;
  pixw: number;
  nrows: number;
  ncols: number;
}

export interface ResistanceResult {
  totalRes: Float32Array;
  lampRes: Float32Array;
  roadRes: Float32Array;
  riverRes: Float32Array;
  landscapeRes: Float32Array;
  linearRes: Float32Array;
  genericRes: Float32Array;
  softSurf: Float32Array;
  hardSurf: Float32Array;
  nrows: number;
  ncols: number;
}

export async function rasterizeGeojson(
  baseRaster: Float32Array,
  nrows: number,
  ncols: number,
  geojsonStr: string,
  layerParamsStr: string,
  xmin: number,
  ymax: number,
  cellsize: number,
): Promise<{ resistanceMap: Float32Array; layerMasks: { name: string; data: Float32Array }[] }> {
  const json = await rasterizeGeojsonAsync(
    f32ToF64(baseRaster),
    nrows,
    ncols,
    -9999.0,
    geojsonStr,
    layerParamsStr,
    xmin,
    ymax,
    cellsize,
  );
  const parsed = JSON.parse(json);
  return {
    resistanceMap: jsonArrayToF32Array(parsed.resistance_map),
    layerMasks: (parsed.layer_masks ?? []).map((m: { name: string; data: number[] }) => ({
      name: m.name,
      data: jsonArrayToF32Array(m.data),
    })),
  };
}


export async function runPipelineBrowser(
  roadBinary: Float32Array,
  riverBinary: Float32Array,
  buildingMask: Float32Array,
  dtm: Float32Array,
  dsm: Float32Array,
  genericResistance: Float32Array,
  lamps: Float32Array,
  landscapeConductance: Float32Array,
  params: ResistanceParams,
  lightmap?: Float32Array,
): Promise<ResistanceResult> {
  try {
    const paramsJson = JSON.stringify(params);
    const result = lightmap
      ? await runResistancePipelineBrowserWithLightmapAsync(
          roadBinary, riverBinary, buildingMask, dtm, dsm, genericResistance, lightmap,
          landscapeConductance, paramsJson,
        )
      : await runResistancePipelineBrowserAsync(
          roadBinary, riverBinary, buildingMask, dtm, dsm, genericResistance, lamps,
          landscapeConductance, paramsJson,
        );

    return {
      totalRes: result.total_res,
      lampRes: result.lamp_res,
      roadRes: result.road_res,
      riverRes: result.river_res,
      landscapeRes: result.landscape_res,
      linearRes: result.linear_res,
      genericRes: result.generic_res,
      softSurf: result.soft_surf,
      hardSurf: result.hard_surf,
      nrows: result.nrows,
      ncols: result.ncols,
    };
  } catch (error) {
    throw new Error(`Resistance pipeline error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
