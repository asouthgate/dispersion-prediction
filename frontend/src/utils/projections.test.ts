import { describe, it, expect } from 'vitest';
import { bngExtentToWgs84Corners, bngToWgs84LngLat } from './projections';

describe('bngExtentToWgs84Corners', () => {
  const bounds: [number, number, number, number] = [287500, 77500, 288500, 78500];

  it('reprojects all four corners in clockwise order', () => {
    const c = bngExtentToWgs84Corners(bounds);
    expect(c[0]).toEqual(bngToWgs84LngLat(287500, 78500)); // TL
    expect(c[1]).toEqual(bngToWgs84LngLat(288500, 78500)); // TR
    expect(c[2]).toEqual(bngToWgs84LngLat(288500, 77500)); // BR
    expect(c[3]).toEqual(bngToWgs84LngLat(287500, 77500)); // BL
  });

  it('preserves the grid rotation (not an axis-aligned box)', () => {
    const c = bngExtentToWgs84Corners(bounds);
    // The BNG grid is a rotated parallelogram in WGS84: the top edge is not
    // horizontal and the left edge is not vertical.
    expect(c[0][1]).not.toBeCloseTo(c[1][1], 6);
    expect(c[0][0]).not.toBeCloseTo(c[3][0], 6);
  });
});
