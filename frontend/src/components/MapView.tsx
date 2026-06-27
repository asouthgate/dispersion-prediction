import { useMemo } from 'react';
import type { DrawMode } from '@gsbio/engine';
import { MapScene, DrawToolbar, type DrawTool } from '@gsbio/engine';
import {
  createTerraDraw2DRenderer,
  type TerraDraw2DRenderer,
  type FeatureStyleConfig,
  type ResultPaint,
} from '@gsbio/engine';
import { OSM_RASTER_STYLE } from '@gsbio/engine';

const CENTER: [number, number] = [-3.590523, 50.586362];
const ZOOM = 13;

const TOOLS: Array<{ mode: DrawMode; label: string; icon: string; color: string }> = [
  { mode: 'circle', label: 'Roost', icon: '◉', color: '#5b8def' },
  { mode: 'polygon', label: 'Building', icon: '⬡', color: '#a0522d' },
  { mode: 'linestring', label: 'Road', icon: '⏛', color: '#888888' },
  { mode: 'linestring', label: 'River', icon: '〰', color: '#3678b5' },
  { mode: 'point', label: 'Lights', icon: '💡', color: '#ffbd17' },
  { mode: 'linestring', label: 'LightString', icon: '✦', color: '#ff9900' },
];

const drawTools: DrawTool[] = TOOLS.map((t) => ({ mode: t.mode, label: t.label, icon: t.icon }));

const Feature_OPACITY = 0.2;

const featureStyles: FeatureStyleConfig = {
  tools: [
    ...TOOLS.map((t) => {
      const base = { fillColor: t.color, fillOpacity: Feature_OPACITY, outlineColor: t.color, outlineWidth: 2 };
      switch (t.mode) {
        case 'point':
          return { mode: t.mode, category: t.label, style: { pointColor: t.color, pointOutlineColor: '#0a0e10', pointRadius: 7 } };
        case 'circle':
          return { mode: t.mode, category: t.label, style: { ...base } };
        case 'linestring':
          return { mode: t.mode, category: t.label, style: { lineColor: t.color, lineWidth: 2 } };
        case 'polygon':
          return { mode: t.mode, category: t.label, style: { ...base } };
        default:
          return { mode: t.mode, category: t.label, style: base };
      }
    }),
  ],
};

const resultStyles: ResultPaint = {
  lineWidth: 2,
  fillOpacity: 0.28,
  circleRadius: 6,
};

export function MapView() {
  const renderer = useMemo<TerraDraw2DRenderer>(
    () =>
      createTerraDraw2DRenderer({
        style: OSM_RASTER_STYLE as never,
        center: CENTER,
        zoom: ZOOM,
        featureStyles,
        resultStyles,
      }),
    [],
  );

  return (
    <MapScene renderer={renderer}>
      <DrawToolbar
        tools={drawTools}
        onStartDrawing={renderer.startDrawing}
        onSelectMode={renderer.selectMode}
      />
    </MapScene>
  );
}
