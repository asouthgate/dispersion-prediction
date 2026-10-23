import type { Executor, ResultLayerEntry, SimulationEngine } from '@gsbio/engine';
import { plotRaster, encodeGeoTiff, type RasterPlotSpec } from '@gsbio/engine';
import { computeRoostFinder, base64ToFloat32, type RoostFinderWasmResult } from '../../wasm/roostCompute';
import {
  roostFinderModel,
  roostParamsToArgs,
  ROOST_SURFACE_LAYER_ID,
  ROOST_INPUTS_SOURCE_ID,
  type RoostFinderInputs,
} from './model';
import { bngToWgs84LngLat } from '../../utils/projections';

export interface RoostFinderSummary {
  predicted: { x: number; y: number };
  loss: number;
  detectorCount: number;
}

/** Contour levels as fractions of the maximum loss (matches the paper). */
const CONTOUR_LEVELS = [0.1, 0.2, 0.3, 0.4];

function pointLayer(raw: RoostFinderWasmResult): ResultLayerEntry {
  const point = (x: number, y: number, kind: string, count?: number): GeoJSON.Feature<GeoJSON.Point> => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: bngToWgs84LngLat(x, y) },
    properties: { kind, ...(count === undefined ? {} : { count }) },
  });
  const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [
    ...raw.detectors.map(d => point(d.x, d.y, 'detector', d.count)),
    point(raw.x, raw.y, 'roost'),
    point(raw.weighted_mean_x, raw.weighted_mean_y, 'calls'),
  ] };
  const legend = [
    { value: 'roost', label: 'Estimated roost', radius: 8, color: '#e11d48', strokeColor: '#ffffff', strokeWidth: 2 },
    { value: 'calls', label: 'Center of calls', radius: 7, color: '#2563eb', strokeColor: '#ffffff', strokeWidth: 2 },
    { value: 'detector', label: 'Detector', radius: 4, color: '#111111', strokeColor: '#ffffff', strokeWidth: 1 },
  ];
  return {
    id: 'roost_points', name: 'Roost points', overlay: true, legend,
    envelope: { kind: 'geojson', data, circleStyles: [...legend].reverse() },
    raw: { filename: 'roost_points.geojson', bytes: new TextEncoder().encode(JSON.stringify(data)) },
  };
}

export function createRoostFinderExecutor(): Executor {
  return {
    async preprocess(ctx) {
      const inputs = ctx.sources.find((s) => s.id === ROOST_INPUTS_SOURCE_ID)?.data as RoostFinderInputs | undefined;
      if (!inputs || !inputs.detectors || !inputs.master) {
        ctx.onLog?.('error', 'No detector/call CSVs loaded.');
        throw new Error('Import detector and call CSVs first.');
      }
      return { payload: inputs };
    },

    async submit(ctx) {
      const inputs = ctx.payload as RoostFinderInputs;
      const args = roostParamsToArgs(ctx.params);

      ctx.onLog?.('info', 'Computing roost error surface in browser via WebAssembly…');
      const raw = await computeRoostFinder(inputs.detectors, inputs.master, inputs.sunset ?? '', args);

      for (const w of raw.warnings) ctx.onLog?.('warning', w);
      ctx.onLog?.('info', `Predicted roost (BNG): ${raw.x.toFixed(1)}, ${raw.y.toFixed(1)}  loss=${raw.loss.toExponential(4)}`);

      const data = base64ToFloat32(raw.surface_base64);
      const expected = raw.grid_size * raw.grid_size;
      if (data.length !== expected) {
        throw new Error(`Roost surface size mismatch: ${data.length} != ${expected}`);
      }

      const grid = {
        data,
        width: raw.grid_size,
        height: raw.grid_size,
        crs: 'EPSG:27700' as const,
        bounds: raw.bounds_bng,
      };
      const boundsBng = raw.bounds_bng;

      ctx.onLog?.('info', 'Rendering roost surface…');
      const spec: RasterPlotSpec = {
        palette: 'roost-loss',
        invert: true,
        vmin: 0,
        scale: 'linear',
        label: 'Loss',
        contours: { levels: CONTOUR_LEVELS },
        colorbar: { side: 'right' },
      };
      const plotted = await plotRaster(grid, spec);
      const masked = await plotRaster(grid, { ...spec, alphaRamp: true });

      const tif = new Uint8Array(
        encodeGeoTiff({ data, width: raw.grid_size, height: raw.grid_size }, { bounds: boundsBng }),
      );

      const layers: ResultLayerEntry[] = [
        {
          id: ROOST_SURFACE_LAYER_ID,
          name: 'Roost contours',
          envelope: { kind: 'image', url: plotted.url, bounds: plotted.boundsWgs84 },
          envelopeMasked: { kind: 'image', url: masked.url, bounds: masked.boundsWgs84 },
          raw: { filename: 'roost_loss_surface.tif', bytes: tif },
        },
        pointLayer(raw),
      ];

      const summary: RoostFinderSummary = {
        predicted: { x: raw.x, y: raw.y },
        loss: raw.loss,
        detectorCount: raw.detectors.length,
      };

      return { layers, summary };
    },
  };
}

export function installRoostFinder(engine: SimulationEngine): void {
  engine.registerModel(roostFinderModel);
  engine.registerExecutor(roostFinderModel.id, createRoostFinderExecutor());
}
