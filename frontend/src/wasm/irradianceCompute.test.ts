import { describe, it, expect, beforeAll } from 'vitest';
import {
  ensureWasm,
  irradianceRun,
  irradianceToResistance,
  irradianceCombine,
  NODATA_THRESHOLD,
} from './irradianceCompute';

beforeAll(async () => {
  await ensureWasm();
});

describe('irradianceCombine', () => {
  it('sums rasters and squashes to [1, 10000]', () => {
    const m = 2, n = 2;
    const lamp = new Float32Array([10, 0, 0, 0]);
    const zero = new Float32Array(4);
    const result = irradianceCombine(lamp, zero, zero, zero, zero, zero, m, n);
    // sums: [11, 1, 1, 1] -> squash: [10000, 1, 1, 1]
    expect(result[0]).toBeCloseTo(10000, 1);
    expect(result[1]).toBeCloseTo(1, 4);
    expect(result[2]).toBeCloseTo(1, 4);
    expect(result[3]).toBeCloseTo(1, 4);
  });

  it('returns all-1 output when all inputs are zero', () => {
    const zero = new Float32Array(9);
    const result = irradianceCombine(zero, zero, zero, zero, zero, zero, 3, 3);
    for (const v of result) expect(v).toBe(1);
  });

  it('clamps R NoData sentinel values to 0 instead of propagating them', () => {
    const m = 2, n = 2;
    const lamp = new Float32Array([5, 5, 5, 5]);
    const zero = new Float32Array(4);
    const landscape = new Float32Array([-3.3999999521443642e38, 10, 10, 10]);
    const result = irradianceCombine(lamp, zero, zero, landscape, zero, zero, m, n);
    for (let i = 0; i < result.length; i++) {
      expect(Number.isFinite(result[i])).toBe(true);
      expect(result[i]).toBeGreaterThanOrEqual(1);
      expect(result[i]).toBeLessThanOrEqual(10000);
    }
    // Pixel 0's landscape sentinel was clamped: its sum is smaller than the others
    expect(result[1]).toBeGreaterThan(result[0]);
    // The mutation happened in-place (clamped array reused by caller)
    expect(landscape[0]).toBe(0);
    expect(landscape[0]).toBeGreaterThan(NODATA_THRESHOLD);
  });
});

describe('irradianceToResistance', () => {
  it('maps max irradiance to resmax and zero to zero', () => {
    const irradiance = new Float32Array([0, 4, 0, 1]);
    const result = irradianceToResistance(irradiance, 2, 2, 100, 1);
    expect(result[0]).toBeCloseTo(0, 5);
    expect(result[1]).toBeCloseTo(100, 3);
    expect(result[3]).toBeCloseTo(25, 3);
  });

  it('returns zeros unchanged when there is no irradiance', () => {
    const irradiance = new Float32Array(4);
    const result = irradianceToResistance(irradiance, 2, 2, 100, 1);
    for (const v of result) expect(v).toBe(0);
  });
});

describe('irradianceRun', () => {
  const m = 11, n = 11;
  const flat = new Float32Array(m * n);

  function singleLamp(col: number, row: number, z: number) {
    return new Float32Array([col, row, z]);
  }

  it('produces positive irradiance around a lamp on flat terrain', () => {
    const result = irradianceRun(singleLamp(5, 5, 5), flat, flat, flat, m, n, 1, 100, 0, 0.5);
    const centerIdx = 5 * n + 5;
    const northIdx = 4 * n + 5;
    const twoNorthIdx = 3 * n + 5;
    expect(result[northIdx]).toBeGreaterThan(0);
    expect(result[twoNorthIdx]).toBeGreaterThan(0);
    // Closer pixel receives more irradiance than farther one (inverse-square falloff)
    expect(result[northIdx]).toBeGreaterThan(result[twoNorthIdx]);
    // The lamp's own pixel gets nothing (zero vertical distance to itself)
    expect(result[centerIdx]).toBe(0);
  });

  it('is symmetric around the lamp', () => {
    const result = irradianceRun(singleLamp(5, 5, 5), flat, flat, flat, m, n, 1, 100, 0, 0.5);
    expect(result[4 * n + 5]).toBeCloseTo(result[6 * n + 5], 5);
    expect(result[5 * n + 4]).toBeCloseTo(result[5 * n + 6], 5);
    expect(result[4 * n + 5]).toBeCloseTo(result[5 * n + 4], 5);
  });

  it('respects the cutoff radius', () => {
    const cutoff = 2; // meters; pixw=1 -> 2 px cutoff
    const result = irradianceRun(singleLamp(5, 5, 5), flat, flat, flat, m, n, 1, cutoff, 0, 0.5);
    expect(result[4 * n + 5]).toBeGreaterThan(0); // 1m away: inside cutoff
    expect(result[0 * n + 0]).toBe(0); // corner: well outside cutoff
    expect(result[0 * n + 5]).toBe(0); // 5m away: outside cutoff
  });

  it('ignores lamps outside the raster bounds', () => {
    const result = irradianceRun(singleLamp(-5, -5, 5), flat, flat, flat, m, n, 1, 100, 0, 0.5);
    for (const v of result) expect(v).toBe(0);
  });

  it('casts shadows behind tall hard surfaces', () => {
    const hard = new Float32Array(m * n);
    // Wall of buildings at row 5 (south of lamp at row 5? no: hard surface ring at row 5 except center)
    // Put a tall building one pixel south of the lamp and check the pixel behind it is shadowed.
    hard[6 * n + 5] = 50;
    const shadowed = irradianceRun(singleLamp(5, 5, 5), flat, hard, flat, m, n, 1, 100, 0, 0.5);
    const clear = irradianceRun(singleLamp(5, 5, 5), flat, flat, flat, m, n, 1, 100, 0, 0.5);
    // Pixel two south of the lamp (row 7, col 5): ray passes through the building pixel
    expect(shadowed[7 * n + 5]).toBeLessThan(clear[7 * n + 5]);
    expect(shadowed[7 * n + 5]).toBe(0);
    // Pixel to the north is unaffected
    expect(shadowed[4 * n + 5]).toBeCloseTo(clear[4 * n + 5], 5);
  });
});
