import type { ModelDef, ModelParams } from '@gsbio/engine';
import type { RoostFinderWasmParams } from '../../wasm/roostCompute';

export const ROOST_FINDER_MODEL_ID = 'roost-finder';

export const ROOST_SURFACE_LAYER_ID = 'roost_surface';

export const ROOST_INPUTS_SOURCE_ID = 'roost-finder-inputs';

export interface RoostFinderInputs {
  detectors: string;
  master: string;
  sunset: string | null;
}

export const roostFinderModel: ModelDef = {
  id: ROOST_FINDER_MODEL_ID,
  name: 'Roost Finder',
  description: 'Estimates a bat roost location from per-detector call data.',
  autoShowLayerIds: [ROOST_SURFACE_LAYER_ID],
  params: [
    { key: 'diffusivity', label: 'Diffusivity (m²/s)', type: 'number', min: 0.1, step: 0.1, default: 81.7 },
    { key: 'grid_size', label: 'Grid size', type: 'number', min: 2, step: 1, default: 500 },
    { key: 't0', label: 't0 (seconds)', type: 'number', min: 0.0001, step: 0.01, default: 0.01 },
    {
      key: 't1',
      label: 't1 / observation window (seconds)',
      type: 'number',
      min: 1,
      step: 1,
      default: 5400,
    },
  ],
};

export function roostParamsToArgs(p: ModelParams): RoostFinderWasmParams {
  return {
    gridSize: Math.round(p.grid_size ?? 500),
    diffusivity: p.diffusivity ?? 81.7,
    t0: p.t0 ?? 0.01,
    t1: p.t1 ?? 5400,
  };
}
