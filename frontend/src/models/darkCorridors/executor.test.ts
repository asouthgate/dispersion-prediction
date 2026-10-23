import { beforeEach, expect, it, vi } from 'vitest';
import type { PreprocessContext, RasterPlotResult, SubmitContext } from '@gsbio/engine';
import type { ResistanceResult } from '../../wasm/resistanceCompute';

vi.mock('@gsbio/engine', async importOriginal => ({
  ...await importOriginal<typeof import('@gsbio/engine')>(), plotRaster: vi.fn(),
}));
vi.mock('@gsbio/engine/remote', () => ({ runRemoteJob: vi.fn() }));
vi.mock('../horseshoeBat/resistancePipeline', async importOriginal => ({
  ...await importOriginal<typeof import('../horseshoeBat/resistancePipeline')>(),
  ingestResistanceData: vi.fn(), computeResistancePipeline: vi.fn(),
}));
vi.mock('../../wasm/connectivityCompute', () => ({ solveConnectivity: vi.fn() }));
vi.mock('../../utils/projections', () => ({ wgs84ToBng: () => [300001.2, 60000.8] }));

import { plotRaster, encodeGeoTiff } from '@gsbio/engine';
import { runRemoteJob } from '@gsbio/engine/remote';
import { ingestResistanceData, computeResistancePipeline } from '../horseshoeBat/resistancePipeline';
import { solveConnectivity } from '../../wasm/connectivityCompute';
import { JET_COLORS } from '../../../wasm-connectivity/example/src/render.js';
import { createHorseshoeBatExecutor } from '../horseshoeBat/executor';
import { horseshoeBatModel } from '../horseshoeBat/model';

beforeEach(() => vi.resetAllMocks());

it('routes the darkness stage through lighting-only preprocessing', async () => {
  const executor = createHorseshoeBatExecutor();
  const roost = { category: 'Roost', circle: { center: { lat: 50, lng: -3 }, radiusMeters: 100 } };
  const lamp = { id: 'lamp', category: 'Lights' };
  const ctx = { stage: 'darkness', params: { resolution: 2 }, features: [roost, lamp, { category: 'Road' }] } as unknown as PreprocessContext;
  const prepared = await executor.preprocess(ctx, new AbortController().signal);
  expect(prepared.payload).toMatchObject({ stage: 'darkness', lampFeatures: [lamp], params: { resolution: 2 } });
  await expect(executor.preprocess({ ...ctx, features: ctx.features.filter(feature => feature.category !== 'Lights') }, new AbortController().signal))
    .rejects.toThrow('Import lamp points or a light map first.');
});

it('keeps dark cells conductive, solves only lighting resistance, and maps both outputs with Jet quantiles', async () => {
  const extent = { m: 2, n: 2, pixw: 1, xmin: 300000, ymin: 60000, xmax: 300002, ymax: 60002 };
  const bounds: [number, number, number, number] = [extent.xmin, extent.ymin, extent.xmax, extent.ymax];
  const lampRes = new Float32Array([0, NaN, 5, 10]);
  vi.mocked(runRemoteJob).mockResolvedValue({ status: 'completed', result: {
    job_id: 'job', raw_tifs: {}, raw_geojson: {}, raster_extent: extent,
  } } as Awaited<ReturnType<typeof runRemoteJob>>);
  vi.mocked(ingestResistanceData).mockResolvedValue({ pipelineInput: {} } as Awaited<ReturnType<typeof ingestResistanceData>>);
  vi.mocked(computeResistancePipeline).mockResolvedValue({
    lampRes, totalRes: new Float32Array([999, 999, 999, 999]), nrows: 2, ncols: 2,
  } as ResistanceResult);
  vi.mocked(solveConnectivity).mockResolvedValue({
    current: new Float32Array([1, 99, 2, 10]), voltages: new Float32Array(4), nrows: 2, ncols: 2, totalIters: 1,
  });
  vi.mocked(plotRaster).mockResolvedValue({ url: 'plot', boundsWgs84: bounds } as RasterPlotResult);
  const lamps = [{ id: 'lamp', category: 'Lights' }];
  const params = { resolution: 1, n_circles: 50, lamp_resmax: 100, lamp_xmax: 1, lamp_ext: 100 };
  const ctx = { payload: {
    stage: 'darkness',
    roost: { lat: 50, lng: -3, radiusMeters: 1 }, lampFeatures: lamps, params,
  } } as unknown as SubmitContext;
  const result = await createHorseshoeBatExecutor().submit(ctx, new AbortController().signal);
  expect(horseshoeBatModel.stages?.map(stage => stage.key)).toEqual(['coverage', 'resistance', 'current', 'darkness']);

  const [resistance, rows, cols, nodata, , ground] = vi.mocked(solveConnectivity).mock.calls[0];
  const expectedResistance = new Float32Array([0.1, NaN, 5.1, 10.1]);
  expect(resistance).toEqual(expectedResistance);
  expect([rows, cols, nodata]).toEqual([2, 2, -9999]);
  expect([...ground]).toEqual([0, 0, 0, 1]);
  expect([...lampRes]).toEqual([0, NaN, 5, 10]);
  expect(vi.mocked(ingestResistanceData).mock.calls[0][0].features).toBe(lamps);
  expect(vi.mocked(runRemoteJob).mock.calls[0][1]).toMatchObject({ params, features: [] });
  expect(plotRaster).toHaveBeenCalledTimes(4);
  for (const [grid, spec] of vi.mocked(plotRaster).mock.calls) {
    expect([...grid.data]).toEqual([0, 0, 50, 100]);
    expect(spec).toMatchObject({ palette: JET_COLORS, scale: 'linear', vmin: 0, vmax: 100, alphaCutoff: 0.25 });
  }
  expect(result.layers.map(layer => layer.id)).toEqual(['lamp_res', 'darkness_current']);
  expect(result.layers[0].raw?.bytes).toEqual(new Uint8Array(encodeGeoTiff(
    { data: expectedResistance, width: 2, height: 2 }, { bounds },
  )));
  expect(result.layers[1].raw?.bytes).toEqual(new Uint8Array(encodeGeoTiff(
    { data: new Float32Array([1, NaN, 2, 10]), width: 2, height: 2 }, { bounds },
  )));
});
