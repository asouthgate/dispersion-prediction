interface WorkerResponse {
  id: number;
  result?: unknown;
  error?: string;
}

let worker: Worker | null = null;
let reqId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./connectivity.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const { id, result, error } = e.data as WorkerResponse;
      const cb = pending.get(id);
      if (!cb) return;
      pending.delete(id);
      if (error) cb.reject(new Error(error));
      else cb.resolve(result);
    };
    worker.onerror = (e) => {
      const err = new Error(e.message || 'connectivity worker error');
      for (const [, cb] of pending) cb.reject(err);
      pending.clear();
    };
  }
  return worker;
}

function callWorker(args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, args });
  });
}

function jsonArrayToF32Array(values: unknown): Float32Array {
  const arr = values as number[];
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i];
  return out;
}

export interface ConnectivitySolveResult {
  voltages: Float32Array;
  current: Float32Array;
  nrows: number;
  ncols: number;
  totalIters: number;
  /** Non-fatal residual warning (solve finished but did not reach `tol`). */
  warning?: string;
}

export async function solveConnectivity(
  resistance: Float32Array,
  nrows: number,
  ncols: number,
  nodata: number,
  source: Float32Array,
  ground: Float32Array,
  maxIter = 100_000,
  tol = 1e-4,
  useDirichletGround = false,
): Promise<ConnectivitySolveResult> {
  // Circuitscape excludes sources and grounds on missing resistance cells.
  // WASM retains those cells as high-resistance nodes for multigrid, so leaving
  // sources there would inject current outside the actual study area.
  const maskedSource = source.slice();
  const maskedGround = ground.slice();
  for (let i = 0; i < resistance.length; i++) {
    if (!Number.isFinite(resistance[i]) || resistance[i] <= 0 || resistance[i] === nodata) {
      maskedSource[i] = 0;
      maskedGround[i] = 0;
    }
  }
  const json = await callWorker([
    resistance, nrows, ncols, nodata, maskedSource, maskedGround, maxIter, tol, useDirichletGround,
  ]) as string;
  const parsed = JSON.parse(json) as {
    output?: { voltages?: number[]; current_map?: number[]; nrows?: number; ncols?: number };
    total_iters?: number;
    error?: string | null;
  };
  if (!parsed.output?.voltages || !parsed.output.current_map) {
    throw new Error(parsed.error ? `Connectivity solve error: ${parsed.error}` : 'Connectivity solve returned no voltage/current maps.');
  }
  return {
    voltages: jsonArrayToF32Array(parsed.output.voltages),
    current: jsonArrayToF32Array(parsed.output.current_map),
    nrows: parsed.output.nrows ?? nrows,
    ncols: parsed.output.ncols ?? ncols,
    totalIters: parsed.total_iters ?? 0,
    ...(parsed.error ? { warning: parsed.error } : {}),
  };
}
