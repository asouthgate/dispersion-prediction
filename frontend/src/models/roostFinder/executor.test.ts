import { expect, it, vi } from 'vitest';
import type { SubmitContext, RasterPlotResult } from '@gsbio/engine';

vi.mock('@gsbio/engine', async importOriginal => ({
  ...await importOriginal<typeof import('@gsbio/engine')>(), plotRaster: vi.fn(),
}));
vi.mock('../../wasm/roostCompute', () => ({ computeRoostFinder: vi.fn(), base64ToFloat32: vi.fn() }));

import { plotRaster } from '@gsbio/engine';
import { computeRoostFinder, base64ToFloat32 } from '../../wasm/roostCompute';
import { bngToWgs84LngLat } from '../../utils/projections';
import { createRoostFinderExecutor } from './executor';

it('returns a contour image without baked points plus an independent vector layer and legend', async () => {
  const bounds: [number, number, number, number] = [300000, 60000, 300010, 60010];
  vi.mocked(computeRoostFinder).mockResolvedValue({
    x: 300003, y: 60004, loss: 1, grid_size: 2, bounds_bng: bounds, surface_base64: '',
    weighted_mean_x: 300005, weighted_mean_y: 60006,
    detectors: [{ x: 300001, y: 60002, count: 7 }], warnings: [],
  });
  vi.mocked(base64ToFloat32).mockReturnValue(new Float32Array([1, 2, 3, 4]));
  vi.mocked(plotRaster).mockImplementation(async (_grid, spec) => ({
    url: spec.alphaRamp ? 'masked-contours' : 'contours', boundsWgs84: bounds,
  } as RasterPlotResult));
  const ctx = { params: {}, payload: { detectors: 'detectors', master: 'calls' } } as SubmitContext;
  const result = await createRoostFinderExecutor().submit(ctx, new AbortController().signal);
  expect(result.layers).toHaveLength(2);
  expect(plotRaster).toHaveBeenCalledTimes(2);
  for (const [, spec] of vi.mocked(plotRaster).mock.calls) {
    expect(spec.annotations).toBeUndefined();
    expect(spec.contours?.levels).toEqual([0.1, 0.2, 0.3, 0.4]);
  }
  const [surface, points] = result.layers;
  expect(surface.envelope).toMatchObject({ kind: 'image', url: 'contours' });
  expect(surface.envelopeMasked).toMatchObject({ kind: 'image', url: 'masked-contours' });
  expect(points.overlay).toBe(true);
  expect(points.legend?.map(item => item.label)).toEqual(['Estimated roost', 'Center of calls', 'Detector']);
  if (points.envelope.kind !== 'geojson') throw new Error('Expected vector points');
  expect(points.envelope.data.features).toHaveLength(3);
  expect(points.envelope.data.features.map(feature => feature.geometry)).toEqual([
    { type: 'Point', coordinates: bngToWgs84LngLat(300001, 60002) },
    { type: 'Point', coordinates: bngToWgs84LngLat(300003, 60004) },
    { type: 'Point', coordinates: bngToWgs84LngLat(300005, 60006) },
  ]);
  expect(points.envelope.circleStyles?.map(style => style.value)).toEqual(['detector', 'calls', 'roost']);
  expect(points.raw?.filename).toBe('roost_points.geojson');
  expect(JSON.parse(new TextDecoder().decode(points.raw!.bytes))).toEqual(points.envelope.data);
});
