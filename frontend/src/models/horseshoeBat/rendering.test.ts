import { beforeEach, expect, it, vi } from 'vitest';
import type { RasterPlotResult, SubmitContext } from '@gsbio/engine';
import type { ResistanceResult } from '../../wasm/resistanceCompute';

vi.mock('@gsbio/engine', async (importOriginal) => ({
  ...await importOriginal<typeof import('@gsbio/engine')>(),
  plotRaster: vi.fn(),
}));
vi.mock('@gsbio/engine/remote', () => ({ runRemoteJob: vi.fn() }));
vi.mock('../../wasm/geotiffFetch', () => ({ fetchRaster: vi.fn() }));
vi.mock('../../wasm/connectivityCompute', () => ({ solveConnectivity: vi.fn() }));
vi.mock('./resistancePipeline', async (importOriginal) => ({
  ...await importOriginal<typeof import('./resistancePipeline')>(),
  ingestResistanceData: vi.fn(),
  computeResistancePipeline: vi.fn(),
}));

import { plotRaster, encodeGeoTiff } from '@gsbio/engine';
import { runRemoteJob } from '@gsbio/engine/remote';
import { fetchRaster } from '../../wasm/geotiffFetch';
import { buildResistanceResultLayers, ingestResistanceData, computeResistancePipeline } from './resistancePipeline';
import { solveConnectivity } from '../../wasm/connectivityCompute';
import { JET_COLORS } from '../../../wasm-connectivity/example/src/render.js';
import { createHorseshoeBatExecutor } from './executor';

const extent = { m: 2, n: 2, pixw: 1, xmin: 300000, ymin: 60000, xmax: 300002, ymax: 60002 };
const bounds: [number, number, number, number] = [extent.xmin, extent.ymin, extent.xmax, extent.ymax];
const fields = [
  ['road_res', 'roadRes'], ['river_res', 'riverRes'], ['linear_res', 'linearRes'],
  ['lamp_res', 'lampRes'], ['log_lamp_res', 'lampRes'], ['generic_res', 'genericRes'],
  ['soft_surf', 'softSurf'], ['hard_surf', 'hardSurf'], ['total_res', 'totalRes'],
  ['landscape_res', 'landscapeRes'], ['log_total_res', 'totalRes'],
] as const;
let active: number;
let peak: number;

beforeEach(() => {
  vi.resetAllMocks();
  active = 0;
  peak = 0;
  vi.mocked(plotRaster).mockImplementation(async (_grid, spec) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 0));
    active--;
    return { url: `${spec.label}-${spec.alphaRamp ? 'alpha' : 'opaque'}`, boundsWgs84: bounds } as RasterPlotResult;
  });
});

it('renders one resistance layer at a time and preserves both images and all masked TIFF exports', async () => {
  const result = { nrows: 2, ncols: 2 } as ResistanceResult;
  for (const [, field] of fields) result[field] = new Float32Array([1, 2, 3, 4]);
  const layers = await buildResistanceResultLayers(result, new Uint8Array([1, 0, 1, 1]), extent);
  expect(peak).toBe(1);
  expect(layers.map(layer => layer.id)).toEqual(fields.map(([id]) => id));
  expect(plotRaster).toHaveBeenCalledTimes(22);
  const expectedTif = new Uint8Array(encodeGeoTiff(
    { data: new Float32Array([1, NaN, 3, 4]), width: 2, height: 2 }, { bounds },
  ));
  for (const [i, layer] of layers.entries()) {
    expect(layer.envelope).toEqual({ kind: 'image', url: `${layer.name}-opaque`, bounds });
    expect(layer.envelopeMasked).toEqual({ kind: 'image', url: `${layer.name}-alpha`, bounds });
    expect(layer.raw).toEqual({ filename: `${layer.id}.tif`, bytes: expectedTif });
    const [grid, spec] = vi.mocked(plotRaster).mock.calls[i * 2];
    expect([...grid.data]).toEqual([1, NaN, 3, 4]);
    expect(spec.scale).toBe(layer.id.startsWith('log_') ? 'log' : 'linear');
    expect([...result[fields[i][1]]]).toEqual([1, 2, 3, 4]);
  }
});

it('renders server layers sequentially and retains image variants and download URLs', async () => {
  const layers = ['dtm', 'dsm', 'current'].map(id => ({ id, name: id, url: `/${id}.tif`, crs: 'EPSG:27700', bounds }));
  vi.mocked(runRemoteJob).mockResolvedValue({ status: 'completed', result: { job_id: 'job', layers } } as Awaited<ReturnType<typeof runRemoteJob>>);
  vi.mocked(fetchRaster).mockImplementation(async () => {
    expect(active).toBe(0);
    return { data: new Float32Array(4), m: 2, n: 2 } as Awaited<ReturnType<typeof fetchRaster>>;
  });
  const ctx = { payload: { stage: 'coverage', roost: {}, features: [], params: {} } } as unknown as SubmitContext;
  const result = await createHorseshoeBatExecutor().submit(ctx, new AbortController().signal);
  expect(peak).toBe(1);
  expect(fetchRaster).toHaveBeenCalledTimes(3);
  expect(result.layers.map(layer => layer.id)).toEqual(['dtm', 'dsm', 'current']);
  for (const layer of result.layers) {
    const label = layer.id === 'current' ? 'Current percentile (%)' : layer.id;
    expect(layer.envelope).toEqual({ kind: 'image', url: `${label}-opaque`, bounds });
    expect(layer.envelopeMasked).toEqual({ kind: 'image', url: `${label}-alpha`, bounds });
    expect(layer.raw).toEqual({ filename: `${layer.id}.tif`, url: `/${layer.id}.tif` });
  }
});

it('uses identical percentile colours for WASM and both server current views, retaining raw TIFFs', async () => {
  const pipeline = { nrows: 2, ncols: 2 } as ResistanceResult;
  for (const [, field] of fields) pipeline[field] = new Float32Array([10, NaN, 10, 10]);
  vi.mocked(ingestResistanceData).mockResolvedValue({
    pipelineInput: {}, coverageMask: new Uint8Array([1, 0, 1, 1]), extractedLampCount: 0,
  } as Awaited<ReturnType<typeof ingestResistanceData>>);
  vi.mocked(computeResistancePipeline).mockResolvedValue(pipeline);
  const current = new Float32Array([1, 99, 2, 10]);
  vi.mocked(solveConnectivity).mockResolvedValue({
    voltages: new Float32Array(4), current, nrows: 2, ncols: 2, totalIters: 1,
  });
  vi.mocked(runRemoteJob).mockResolvedValue({ status: 'completed', result: {
    job_id: 'job', layers: [], raw_tifs: {}, raster_extent: extent,
  } } as Awaited<ReturnType<typeof runRemoteJob>>);
  const ctx = { artifacts: { set: vi.fn() }, payload: {
    stage: 'connectivity', roost: { lat: 50, lng: -3, radiusMeters: 10 },
    features: [], lampFeatures: [], resistanceFeatures: [], params: {},
  } } as unknown as SubmitContext;
  const result = await createHorseshoeBatExecutor().submit(ctx, new AbortController().signal);
  const wasmPlots = vi.mocked(plotRaster).mock.calls.filter(([, spec]) => spec.label === 'Current percentile (%)');
  expect(wasmPlots).toHaveLength(2);
  expect([...wasmPlots[0][0].data]).toEqual([0, 0, 50, 100]);
  expect(wasmPlots[0][1]).toMatchObject({ palette: JET_COLORS, scale: 'linear', vmin: 0, vmax: 100, alphaCutoff: 0.25 });
  expect(result.layers.find(layer => layer.id === 'connectivity_current')?.raw).toEqual({
    filename: 'connectivity_current.tif', bytes: new Uint8Array(encodeGeoTiff(
      { data: new Float32Array([1, NaN, 2, 10]), width: 2, height: 2 }, { bounds },
    )),
  });
  expect([...current]).toEqual([1, 99, 2, 10]);

  vi.mocked(plotRaster).mockClear();
  vi.mocked(runRemoteJob).mockResolvedValue({ status: 'completed', result: { layers:
    ['current', 'log_current'].map(id => ({ id, name: id, url: `/${id}.tif`, crs: 'EPSG:27700', bounds,
      display: { preTransformed: id === 'log_current', transform: 'log1p', scale: 'linear' },
    })),
  } } as Awaited<ReturnType<typeof runRemoteJob>>);
  vi.mocked(fetchRaster).mockResolvedValue({ data: new Float32Array([1, 0, 2, 10]), m: 2, n: 2 } as Awaited<ReturnType<typeof fetchRaster>>);
  await createHorseshoeBatExecutor().submit({ payload: { stage: 'coverage', roost: {} } } as SubmitContext, new AbortController().signal);
  expect(plotRaster).toHaveBeenCalledTimes(4);
  for (const [grid, spec] of vi.mocked(plotRaster).mock.calls) {
    expect(grid.data).toEqual(wasmPlots[0][0].data);
    expect(spec).toMatchObject({ palette: JET_COLORS, label: 'Current percentile (%)', scale: 'linear', vmin: 0, vmax: 100, alphaCutoff: 0.25, transform: 'none', preTransformed: false });
  }
  expect(vi.mocked(fetchRaster).mock.calls.map(([url]) => url)).toEqual(['/current.tif', '/current.tif']);
});

it('propagates rendering failures without starting further resistance layers', async () => {
  const result = { nrows: 2, ncols: 2 } as ResistanceResult;
  for (const [, field] of fields) result[field] = new Float32Array(4);
  vi.mocked(plotRaster).mockRejectedValueOnce(new Error('Render failed'));
  await expect(buildResistanceResultLayers(result, new Uint8Array(4).fill(1), extent)).rejects.toThrow('Render failed');
  expect(plotRaster).toHaveBeenCalledTimes(1);
});
