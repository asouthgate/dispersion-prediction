import { initSync, __reset, solve_raster_circuitscape_mixed } from '../../wasm-connectivity/lib/wasm_connect.js';
import wasmUrl from '../../wasm-connectivity/lib/wasm_connect_bg.wasm?url';

let compiledModule = null;

async function getCompiledModule() {
  if (!compiledModule) {
    const resp = await fetch(wasmUrl);
    compiledModule = await WebAssembly.compile(await resp.arrayBuffer());
  }
  return compiledModule;
}

function freshInstance() {
  if (!compiledModule) throw new Error('no compiled wasm module');
  __reset();
  initSync(compiledModule);
}

// Mixed-precision solve takes f32 slices (Float32Array).
function asF32(v) {
  if (v instanceof Float32Array) return v;
  if (ArrayBuffer.isView(v)) return new Float32Array(v);
  if (Array.isArray(v)) return new Float32Array(v);
  return new Float32Array(0);
}

self.onmessage = async (e) => {
  const { id, args } = e.data;
  try {
    await getCompiledModule();
    freshInstance();
    const [resistance, nrows, ncols, nodata, source, ground, maxIter, tol, useDirichletGround] = args;
    const json = solve_raster_circuitscape_mixed(
      asF32(resistance), nrows, ncols, nodata,
      asF32(source), asF32(ground), maxIter, tol, !!useDirichletGround,
    );
    self.postMessage({ id, result: json });
  } catch (err) {
    console.error('connectivity worker error:', err);
    self.postMessage({ id, error: err.message || String(err) });
  }
};
