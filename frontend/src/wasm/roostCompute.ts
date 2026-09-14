import { roostFinderComputeAsync } from '../../wasm-connectivity/lib/wasm.js';

export interface RoostFinderWasmParams {
  gridSize: number;
  diffusivity: number;
  t0: number;
  t1: number;
}

export interface RoostDetectorPoint {
  x: number;
  y: number;
  count: number;
}

export interface RoostFinderWasmResult {
  x: number;
  y: number;
  loss: number;
  /** Loss surface as base64 little-endian f32, row-major, row 0 = north. */
  surface_base64: string;
  grid_size: number;
  /** Search-grid extents in BNG: [xmin, ymin, xmax, ymax]. */
  bounds_bng: [number, number, number, number];
  weighted_mean_x: number;
  weighted_mean_y: number;
  detectors: RoostDetectorPoint[];
  warnings: string[];
}

/** Decode a base64 little-endian f32 payload into a Float32Array. */
export function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.byteOffset % 4 !== 0) {
    const aligned = new Uint8Array(bytes.length);
    aligned.set(bytes);
    return new Float32Array(aligned.buffer);
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
}

export async function computeRoostFinder(
  detectorsCsv: string,
  masterCsv: string,
  sunsetCsv: string,
  params: RoostFinderWasmParams,
): Promise<RoostFinderWasmResult> {
  const json = await roostFinderComputeAsync(
    detectorsCsv,
    masterCsv,
    sunsetCsv,
    params.gridSize,
    params.diffusivity,
    params.t0,
    params.t1,
  );
  const parsed = JSON.parse(json) as RoostFinderWasmResult & { error?: string };
  if (parsed.error) throw new Error(`Roost finder error: ${parsed.error}`);
  return parsed;
}
