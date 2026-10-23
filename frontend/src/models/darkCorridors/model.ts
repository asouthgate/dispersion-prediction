import type { ModelDef } from '@gsbio/engine';

export const DARK_CORRIDORS_MODEL_ID = 'dark-corridors';

export const darkCorridorsModel: ModelDef = {
  id: DARK_CORRIDORS_MODEL_ID,
  name: 'Dark Corridors',
  description:
    'Darkness connectivity from street lighting alone. Computes lamp-only ' +
    'resistance (no landscape, road, or river resistance) and solves current ' +
    'flow in the browser via WebAssembly.',
  autoShowLayerIds: ['darkness_current'],
  params: [
    { key: 'n_circles', label: 'Source circles', type: 'range', min: 1, max: 50, step: 1, default: 50, hidden: true },
    { key: 'resolution', label: 'Resolution (m/px)', type: 'range', min: 1, max: 100, step: 1, default: 10, hidden: true },
    { key: 'radius', label: 'Roost radius (m)', type: 'range', min: 100, max: 5000, step: 50, default: 2500, hidden: true },
    { key: 'lamp_resmax', label: 'Lamp max resistance', type: 'number', min: 1, max: 1e10, step: 1, default: 100000000, group: 'Lamp' },
    { key: 'lamp_xmax', label: 'Lamp slope', type: 'number', min: 1, max: 100, step: 1, default: 1, group: 'Lamp' },
    { key: 'lamp_ext', label: 'Lamp max radius (m)', type: 'number', min: 1, max: 100, step: 1, default: 100, group: 'Lamp' },
  ],
};
