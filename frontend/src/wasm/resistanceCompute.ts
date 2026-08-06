import initModule, { run_resistance_pipeline_wasm, init_panic_hook } from '../../wasm-connectivity/lib/wasm_connect.js';

let initialized = false;

export async function ensureResistanceWasm(): Promise<void> {
  if (initialized) return;
  await initModule();
  init_panic_hook();
  initialized = true;
}

function f32ToF64(arr: Float32Array): Float64Array {
  const out = new Float64Array(arr.length);
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

export interface LampCoords {
  coords: Float32Array;
  extractedCount: number;
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

export function runPipeline(
  roadBinary: Float32Array,
  riverBinary: Float32Array,
  buildingMask: Float32Array,
  lcm: Float32Array,
  dtm: Float32Array,
  dsm: Float32Array,
  genericResistance: Float32Array,
  lamps: Float32Array,
  params: ResistanceParams,
): ResistanceResult {
  const args: Float64Array[] = [
    roadBinary, riverBinary, buildingMask, lcm, dtm, dsm, genericResistance, lamps,
  ].map(f32ToF64);

  const paramsJson = JSON.stringify(params);

  const json = run_resistance_pipeline_wasm(
    args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7],
    paramsJson
  );

  const parsed = JSON.parse(json);

  return {
    totalRes: new Float32Array(parsed.total_res),
    lampRes: new Float32Array(parsed.lamp_res),
    roadRes: new Float32Array(parsed.road_res),
    riverRes: new Float32Array(parsed.river_res),
    landscapeRes: new Float32Array(parsed.landscape_res),
    linearRes: new Float32Array(parsed.linear_res),
    genericRes: new Float32Array(parsed.generic_res),
    softSurf: new Float32Array(parsed.soft_surf),
    hardSurf: new Float32Array(parsed.hard_surf),
    nrows: parsed.nrows,
    ncols: parsed.ncols,
  };
}
