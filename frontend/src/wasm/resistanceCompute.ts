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

function base64ToF32Array(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
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
  const args: Float64Array[] = [
    roadBinary, riverBinary, buildingMask, dtm, dsm, genericResistance, lamps, landscapeConductance,
  ].map(f32ToF64);

  const paramsJson = JSON.stringify(params);

  const json = lightmap
    ? await runResistancePipelineBrowserWithLightmapAsync(
        args[0], args[1], args[2], args[3], args[4], args[5], f32ToF64(lightmap), args[7],
        paramsJson,
      )
    : await runResistancePipelineBrowserAsync(
        args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7],
        paramsJson,
      );

  const parsed = JSON.parse(json);

  if (parsed.error) {
    throw new Error(`Resistance pipeline error: ${parsed.error}`);
  }

  return {
    totalRes:     base64ToF32Array(parsed.total_res),
    lampRes:      base64ToF32Array(parsed.lamp_res),
    roadRes:      base64ToF32Array(parsed.road_res),
    riverRes:     base64ToF32Array(parsed.river_res),
    landscapeRes: base64ToF32Array(parsed.landscape_res),
    linearRes:    base64ToF32Array(parsed.linear_res),
    genericRes:   base64ToF32Array(parsed.generic_res),
    softSurf:     base64ToF32Array(parsed.soft_surf),
    hardSurf:     base64ToF32Array(parsed.hard_surf),
    nrows:        parsed.nrows,
    ncols:        parsed.ncols,
  };
}
