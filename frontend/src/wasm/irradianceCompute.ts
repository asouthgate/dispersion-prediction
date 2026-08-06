interface IrradianceModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  _irradiance_run(
    lampsPtr: number, nlamps: number,
    softPtr: number, hardPtr: number, terrPtr: number,
    outPtr: number, m: number, n: number,
    pixw: number, cutoff: number, sensorHt: number, absorb: number,
  ): void;
  _irradiance_to_resistance(ptr: number, m: number, n: number, resmax: number, xmax: number): void;
  _irradiance_combine(
    totalPtr: number, lampPtr: number, roadPtr: number, riverPtr: number,
    landscapePtr: number, linearPtr: number, genericPtr: number,
    m: number, n: number,
  ): void;
  HEAPF32: Float32Array;
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - Emscripten JS glue, types defined locally
import initIrradianceModule from './irradiance.js';

let mod: IrradianceModule | null = null;

/** R raster package writes NA to GeoTIFF as ≈ -3.4e38; treat anything below this as no-data. */
export const NODATA_THRESHOLD = -1e20;

export async function ensureWasm(): Promise<IrradianceModule> {
  if (mod) return mod;
  mod = (await initIrradianceModule()) as IrradianceModule;
  return mod;
}

function allocAndSet(m: IrradianceModule, data: Float32Array): number {
  const ptr = m._malloc(data.length * 4);
  m.HEAPF32.set(data, ptr / 4);
  return ptr;
}

function readFloat32(m: IrradianceModule, ptr: number, len: number): Float32Array {
  return new Float32Array(m.HEAPF32.buffer, ptr, len).slice();
}

export function irradianceRun(
  lamps: Float32Array,
  softSurf: Float32Array,
  hardSurf: Float32Array,
  terrain: Float32Array,
  m: number,
  n: number,
  pixw: number,
  cutoff: number,
  sensorHt: number,
  absorb: number,
): Float32Array {
  const md = mod;
  if (!md) throw new Error('WASM not initialized');
  const nlamps = lamps.length / 3;
  const size = m * n;
  const lampsPtr = allocAndSet(md, lamps);
  const softPtr = allocAndSet(md, softSurf);
  const hardPtr = allocAndSet(md, hardSurf);
  const terrPtr = allocAndSet(md, terrain);
  const outPtr = md._malloc(size * 4);
  md.HEAPF32.fill(0, outPtr / 4, outPtr / 4 + size);
  md._irradiance_run(lampsPtr, nlamps, softPtr, hardPtr, terrPtr, outPtr, m, n, pixw, cutoff, sensorHt, absorb);
  const result = readFloat32(md, outPtr, size);
  md._free(lampsPtr);
  md._free(softPtr);
  md._free(hardPtr);
  md._free(terrPtr);
  md._free(outPtr);
  return result;
}

export function irradianceToResistance(
  irradiance: Float32Array,
  m: number,
  n: number,
  resmax: number,
  xmax: number,
): Float32Array {
  const md = mod;
  if (!md) throw new Error('WASM not initialized');
  const size = m * n;
  const ptr = allocAndSet(md, irradiance);
  md._irradiance_to_resistance(ptr, m, n, resmax, xmax);
  const result = readFloat32(md, ptr, size);
  md._free(ptr);
  return result;
}

export function irradianceCombine(
  lamp: Float32Array,
  road: Float32Array,
  river: Float32Array,
  landscape: Float32Array,
  linear: Float32Array,
  generic: Float32Array,
  m: number,
  n: number,
): Float32Array {
  const md = mod;
  if (!md) throw new Error('WASM not initialized');
  const size = m * n;

  for (const arr of [road, river, landscape, linear, generic]) {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] < NODATA_THRESHOLD) arr[i] = 0;
    }
  }

  const lampPtr = allocAndSet(md, lamp);
  const roadPtr = allocAndSet(md, road);
  const riverPtr = allocAndSet(md, river);
  const landscapePtr = allocAndSet(md, landscape);
  const linearPtr = allocAndSet(md, linear);
  const genericPtr = allocAndSet(md, generic);
  const totalPtr = md._malloc(size * 4);
  md._irradiance_combine(totalPtr, lampPtr, roadPtr, riverPtr, landscapePtr, linearPtr, genericPtr, m, n);
  const result = readFloat32(md, totalPtr, size);
  md._free(lampPtr);
  md._free(roadPtr);
  md._free(riverPtr);
  md._free(landscapePtr);
  md._free(linearPtr);
  md._free(genericPtr);
  md._free(totalPtr);
  return result;
}
