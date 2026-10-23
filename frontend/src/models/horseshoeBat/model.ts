import type { ModelDef } from '@gsbio/engine';

export type PipelineStage = 'coverage' | 'resistance' | 'current' | 'connectivity';

export const horseshoeBatModel: ModelDef = {
  id: 'horseshoe-bat',
  name: 'Horseshoe Bat',
  description:
    'Models flight line dispersion for horseshoe bats using Circuitscape. ' +
    'Computes resistance layers from landscape features and runs current flow analysis.',
  stages: [
    { key: 'coverage', label: 'Coverage', defaultLayerId: null },
    { key: 'resistance', label: 'Resistance', defaultLayerId: 'log_total_res' },
    { key: 'current', label: 'Current', defaultLayerId: 'log_current' },
    { key: 'connectivity', label: 'Current (experimental)', defaultLayerId: 'connectivity_current' },
  ],
  params: [
    { key: 'n_circles', label: 'Source circles', type: 'range', min: 1, max: 50, step: 1, default: 50 },
    { key: 'resolution', label: 'Resolution (m/px)', type: 'range', min: 1, max: 100, step: 1, default: 10, hidden: true },
    { key: 'radius', label: 'Roost radius (m)', type: 'range', min: 100, max: 5000, step: 50, default: 2500, hidden: true },
    { key: 'road_buffer', label: 'Road buffer (m)', type: 'number', min: 1, max: 1000, step: 1, default: 200, group: 'Road' },
    { key: 'road_resmax', label: 'Road max resistance', type: 'number', min: 1, max: 10000, step: 1, default: 10, group: 'Road' },
    { key: 'road_xmax', label: 'Road slope', type: 'number', min: 1, max: 10, step: 1, default: 5, group: 'Road' },
    { key: 'river_buffer', label: 'River buffer (m)', type: 'number', min: 1, max: 100, step: 1, default: 10, group: 'River' },
    { key: 'river_resmax', label: 'River max resistance', type: 'number', min: 1, max: 10000, step: 1, default: 2000, group: 'River' },
    { key: 'river_xmax', label: 'River slope', type: 'number', min: 1, max: 100, step: 1, default: 4, group: 'River' },
    { key: 'landscape_rankmax', label: 'Landscape max rank', type: 'number', min: 1, max: 100, step: 1, default: 8, group: 'Landscape' },
    { key: 'landscape_resmax', label: 'Landscape max resistance', type: 'number', min: 1, max: 10000, step: 1, default: 100, group: 'Landscape' },
    { key: 'landscape_xmax', label: 'Landscape slope', type: 'number', min: 1, max: 100, step: 1, default: 5, group: 'Landscape' },
    { key: 'linear_buffer', label: 'Linear buffer (m)', type: 'number', min: 1, max: 1000, step: 1, default: 10, group: 'Linear' },
    { key: 'linear_resmax', label: 'Linear max resistance', type: 'number', min: 1, max: 10000, step: 1, default: 22000, group: 'Linear' },
    { key: 'linear_rankmax', label: 'Linear max rank', type: 'number', min: 1, max: 100, step: 1, default: 4, group: 'Linear' },
    { key: 'linear_xmax', label: 'Linear slope', type: 'number', min: 1, max: 100, step: 1, default: 3, group: 'Linear' },
    { key: 'lamp_resmax', label: 'Lamp max resistance', type: 'number', min: 1, max: 1e10, step: 1, default: 100000000, group: 'Lamp' },
    { key: 'lamp_xmax', label: 'Lamp slope', type: 'number', min: 1, max: 100, step: 1, default: 1, group: 'Lamp' },
    { key: 'lamp_ext', label: 'Lamp max radius (m)', type: 'number', min: 1, max: 100, step: 1, default: 100, group: 'Lamp' },
  ],
};
