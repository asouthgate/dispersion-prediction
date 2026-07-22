import type { ModelDef } from '@gsbio/engine';

export type PipelineStage = 'coverage' | 'resistance' | 'current';

export const horseshoeBatModel: ModelDef = {
  id: 'horseshoe-bat',
  name: 'Horseshoe Bat',
  description:
    'Models flight line dispersion for horseshoe bats using Circuitscape. ' +
    'Computes resistance layers from landscape features and runs current flow analysis.',
  params: [
    { key: 'n_circles', label: 'Source circles', type: 'range', min: 1, max: 50, step: 1, default: 50 },
    { key: 'resolution', label: 'Resolution (m/px)', type: 'range', min: 1, max: 100, step: 1, default: 10 },
    { key: 'radius', label: 'Roost radius (m)', type: 'range', min: 100, max: 5000, step: 50, default: 2500 },
    { key: 'road_buffer', label: 'Road buffer (m)', type: 'number', min: 1, max: 1000, step: 1, default: 200 },
    { key: 'road_resmax', label: 'Road max resistance', type: 'number', min: 1, max: 10000, step: 1, default: 10 },
    { key: 'road_xmax', label: 'Road slope', type: 'number', min: 1, max: 10, step: 1, default: 5 },
    { key: 'river_buffer', label: 'River buffer (m)', type: 'number', min: 1, max: 100, step: 1, default: 10 },
    { key: 'river_resmax', label: 'River max resistance', type: 'number', min: 1, max: 10000, step: 1, default: 2000 },
    { key: 'river_xmax', label: 'River slope', type: 'number', min: 1, max: 100, step: 1, default: 4 },
    { key: 'landscape_rankmax', label: 'Landscape max rank', type: 'number', min: 1, max: 100, step: 1, default: 8 },
    { key: 'landscape_resmax', label: 'Landscape max resistance', type: 'number', min: 1, max: 10000, step: 1, default: 100 },
    { key: 'landscape_xmax', label: 'Landscape slope', type: 'number', min: 1, max: 100, step: 1, default: 5 },
    { key: 'linear_buffer', label: 'Linear buffer (m)', type: 'number', min: 1, max: 1000, step: 1, default: 10 },
    { key: 'linear_resmax', label: 'Linear max resistance', type: 'number', min: 1, max: 10000, step: 1, default: 22000 },
    { key: 'linear_rankmax', label: 'Linear max rank', type: 'number', min: 1, max: 100, step: 1, default: 4 },
    { key: 'linear_xmax', label: 'Linear slope', type: 'number', min: 1, max: 100, step: 1, default: 3 },
    { key: 'lamp_resmax', label: 'Lamp max resistance', type: 'number', min: 1, max: 1e10, step: 1, default: 100000000 },
    { key: 'lamp_xmax', label: 'Lamp slope', type: 'number', min: 1, max: 100, step: 1, default: 1 },
    { key: 'lamp_ext', label: 'Lamp max radius (m)', type: 'number', min: 1, max: 100, step: 1, default: 100 },
  ],
};

export const PARAM_GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Road', keys: ['road_buffer', 'road_resmax', 'road_xmax'] },
  { label: 'River', keys: ['river_buffer', 'river_resmax', 'river_xmax'] },
  { label: 'Landscape', keys: ['landscape_rankmax', 'landscape_resmax', 'landscape_xmax'] },
  { label: 'Linear', keys: ['linear_buffer', 'linear_resmax', 'linear_rankmax', 'linear_xmax'] },
  { label: 'Lamp', keys: ['lamp_resmax', 'lamp_xmax', 'lamp_ext'] },
];

export const TOP_PARAMS = ['n_circles'];
