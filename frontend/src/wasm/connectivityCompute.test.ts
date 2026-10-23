import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('excludes sources and grounds on missing resistance without changing caller buffers', async () => {
  vi.resetModules();
  const postMessage = vi.fn(function (this: { onmessage: (event: unknown) => void }, message) {
    this.onmessage({ data: { id: message.id, result: JSON.stringify({
      output: { voltages: [0], current_map: [0] },
    }) } });
  });
  vi.stubGlobal('Worker', class {
    onmessage = () => {};
    postMessage = postMessage;
  });
  const { solveConnectivity } = await import('./connectivityCompute');
  const resistance = new Float32Array([10, NaN, -9999, Infinity, 0, -1, 20, 30]);
  const source = new Float32Array(8).fill(1);
  const ground = new Float32Array(8).fill(2);
  await solveConnectivity(resistance, 2, 4, -9999, source, ground);
  const args = postMessage.mock.calls[0][0].args;
  expect(Array.from(args[4])).toEqual([1, 0, 0, 0, 0, 0, 1, 1]);
  expect(Array.from(args[5])).toEqual([2, 0, 0, 0, 0, 0, 2, 2]);
  expect(Array.from(source)).toEqual(new Array(8).fill(1));
  expect(Array.from(ground)).toEqual(new Array(8).fill(2));
});
