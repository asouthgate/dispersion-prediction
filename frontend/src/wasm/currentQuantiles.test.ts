import { expect, it } from 'vitest';
import { currentQuantiles } from './currentQuantiles';

it('maps ranks rather than magnitudes, excluding missing and zero-current background', () => {
  const input = new Float32Array([0, NaN, -9999, Infinity, 1, 2, 10, 10000]);
  const out = currentQuantiles(input);
  expect([...out.slice(0, 4)]).toEqual([0, 0, 0, 0]);
  expect(out[4]).toBe(0);
  expect(out[5]).toBeCloseTo(100 / 3);
  expect(out[6]).toBeCloseTo(200 / 3);
  expect(out[7]).toBe(100);
  expect(input[7]).toBe(10000);
  expect(Number.isNaN(input[1])).toBe(true);
});

it('gives equal values the same average rank and handles constant and empty rasters', () => {
  expect([...currentQuantiles(new Float32Array([1, 2, 2, 3]))]).toEqual([0, 50, 50, 100]);
  expect([...currentQuantiles(new Float32Array([7, 7]))]).toEqual([50, 50]);
  expect([...currentQuantiles(new Float32Array([7]))]).toEqual([50]);
  expect([...currentQuantiles(new Float32Array([0, NaN]))]).toEqual([0, 0]);
});

it('uses the same mapping for raw and monotonically transformed current', () => {
  const raw = new Float32Array([0, 1, 3, 20, 1000]);
  expect(currentQuantiles(Float32Array.from(raw, Math.log1p))).toEqual(currentQuantiles(raw));
});
