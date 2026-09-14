import type { Executor, ResultLayerEntry, SimulationEngine } from '@gsbio/engine';
import { plotRaster, encodeGeoTiff, type RasterAnnotation } from '@gsbio/engine';
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

function bngBoundsToWgs84(
  bounds: [number, number, number, number],
): [number, number, number, number] {
  const [xmin, ymin, xmax, ymax] = bounds;
  const [west, south] = bngToWgs84LngLat(xmin, ymin);
  const [east, north] = bngToWgs84LngLat(xmax, ymax);
  return [west, south, east, north];
}

function annotations(raw: RoostFinderWasmResult): RasterAnnotation[] {
  const out: RasterAnnotation[] = raw.detectors.map((d) => {
    const [lng, lat] = bngToWgs84LngLat(d.x, d.y);
    return { lng, lat, radius: 4, color: '#111111', strokeColor: '#ffffff', strokeWidth: 1 };
  });
  const [plng, plat] = bngToWgs84LngLat(raw.x, raw.y);
  out.push({ lng: plng, lat: plat, radius: 8, color: '#e11d48' });
  const [wlng, wlat] = bngToWgs84LngLat(raw.weighted_mean_x, raw.weighted_mean_y);
  out.push({ lng: wlng, lat: wlat, radius: 7, color: '#2563eb' });
  return out;
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
        boundsWgs84: bngBoundsToWgs84(raw.bounds_bng),
      };
      const boundsBng = raw.bounds_bng;

      ctx.onLog?.('info', 'Rendering roost surface…');
      const plotted = await plotRaster(grid, {
        palette: 'roost-loss',
        invert: true,
        vmin: 0,
        scale: 'linear',
        label: 'Loss',
        contours: { levels: CONTOUR_LEVELS },
        annotations: annotations(raw),
        colorbar: { side: 'right' },
      });

      const tif = new Uint8Array(
        encodeGeoTiff({ data, width: raw.grid_size, height: raw.grid_size }, { bounds: boundsBng }),
      );

      const layers: ResultLayerEntry[] = [
        {
          id: ROOST_SURFACE_LAYER_ID,
          name: 'Roost result',
          envelope: { kind: 'image', url: plotted.url, bounds: plotted.boundsWgs84 },
          raw: { filename: 'roost_loss_surface.tif', bytes: tif },
        },
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
