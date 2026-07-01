import { useEffect, useMemo, useRef } from 'react';
import type { DrawMode } from '@gsbio/engine';
import {
  MapScene,
  DrawToolbar,
  type DrawTool,
  useEngine,
  type DataFeature,
  destinationPoint,
} from '@gsbio/engine';
import {
  createTerraDraw2DRenderer,
  type TerraDraw2DRenderer,
  type FeatureStyleConfig,
  type ResultPaint,
} from '@gsbio/engine';
import { POSITRON_STYLE } from '@gsbio/engine';
import { Building04 } from 'react-coolicons';
import { CarAuto } from 'react-coolicons';
import { WaterDrop } from 'react-coolicons';
import { Sun } from 'react-coolicons';

const CENTER: [number, number] = [-3.590523, 50.586362];
const ZOOM = 13;

const iconStyle = { width: 18, height: 18 };

const TOOLS: Array<{ mode: DrawMode; label: string; icon: React.ReactNode; color: string }> = [
  { mode: 'circle', label: 'Roost', icon: '◉', color: '#5b8def' },
  { mode: 'polygon', label: 'Building', icon: <Building04 style={iconStyle} />, color: '#a0522d' },
  { mode: 'linestring', label: 'Road', icon: <CarAuto style={iconStyle} />, color: '#888888' },
  { mode: 'linestring', label: 'River', icon: <WaterDrop style={iconStyle} />, color: '#3678b5' },
  { mode: 'point', label: 'Lights', icon: <Sun style={iconStyle} />, color: '#ffbd17' },
  { mode: 'linestring', label: 'LightString', icon: '✦', color: '#ff9900' },
];

const drawTools: DrawTool[] = TOOLS.map((t) => ({ mode: t.mode, label: t.label, icon: t.icon as never }));

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

const ROOST_SOURCE = 'roost-source';
const ROOST_RECT_FILL = 'roost-rect-fill';
const ROOST_RECT_LINE = 'roost-rect-line';
const ROOST_CROSSHAIR = 'roost-crosshair';
const RECT_FILL_COLOR = '#5b8def';
const RECT_LINE_COLOR = '#5b8def';

type MapRef = {
  getStyle(): { layers: Array<{ id: string }> };
  addSource(id: string, source: unknown): void;
  addLayer(layer: unknown, beforeId?: string): void;
  removeLayer(id: string): void;
  removeSource(id: string): void;
};

function n(p: { lng: number; lat: number }, r: number) { return destinationPoint(p, r, 0); }
function e(p: { lng: number; lat: number }, r: number) { return destinationPoint(p, r, 90); }
function s(p: { lng: number; lat: number }, r: number) { return destinationPoint(p, r, 180); }
function w(p: { lng: number; lat: number }, r: number) { return destinationPoint(p, r, 270); }

function addRoostOverlay(map: MapRef, center: { lng: number; lat: number }, radiusMeters: number) {
  removeRoostOverlay(map);
  const rectCoords: [number, number][] = [
    [w(center, radiusMeters).lng, n(center, radiusMeters).lat],
    [e(center, radiusMeters).lng, n(center, radiusMeters).lat],
    [e(center, radiusMeters).lng, s(center, radiusMeters).lat],
    [w(center, radiusMeters).lng, s(center, radiusMeters).lat],
    [w(center, radiusMeters).lng, n(center, radiusMeters).lat],
  ];
  const rectGeom: GeoJSON.Geometry = { type: 'Polygon', coordinates: [rectCoords] };
  const crossGeom: GeoJSON.Geometry = {
    type: 'MultiLineString',
    coordinates: [
      [[w(center, radiusMeters).lng, center.lat], [e(center, radiusMeters).lng, center.lat]],
      [[center.lng, s(center, radiusMeters).lat], [center.lng, n(center, radiusMeters).lat]],
    ],
  };
  map.addSource(ROOST_SOURCE, { type: 'geojson', data: { type: 'Feature', geometry: rectGeom, properties: {} } });
  map.addLayer({ id: ROOST_RECT_FILL, type: 'fill', source: ROOST_SOURCE, paint: { 'fill-color': RECT_FILL_COLOR, 'fill-opacity': 0.08 } });
  map.addLayer({ id: ROOST_RECT_LINE, type: 'line', source: ROOST_SOURCE, paint: { 'line-color': RECT_LINE_COLOR, 'line-width': 1.5 } });
  map.addSource(`${ROOST_SOURCE}-cross`, { type: 'geojson', data: { type: 'Feature', geometry: crossGeom, properties: {} } });
  map.addLayer({ id: ROOST_CROSSHAIR, type: 'line', source: `${ROOST_SOURCE}-cross`, paint: { 'line-color': RECT_LINE_COLOR, 'line-width': 1, 'line-dasharray': [4, 3] } });
}

function removeRoostOverlay(map: MapRef) {
  try { map.removeLayer(ROOST_CROSSHAIR); } catch {}
  try { map.removeLayer(ROOST_RECT_LINE); } catch {}
  try { map.removeLayer(ROOST_RECT_FILL); } catch {}
  try { map.removeSource(`${ROOST_SOURCE}-cross`); } catch {}
  try { map.removeSource(ROOST_SOURCE); } catch {}
}

function RoostOverlay({ renderer }: { renderer: TerraDraw2DRenderer }) {
  const engine = useEngine();
  const mounted = useRef(false);

  useEffect(() => {
    return engine.subscribe(() => {
      const map = renderer.getMap();
      if (!map) return;
      const snapshot = engine.getSnapshot();
      const roost = snapshot.features.features.find((f: DataFeature) => f.category === 'Roost');
      if (roost?.circle) {
        addRoostOverlay(map, roost.circle.center, roost.circle.radiusMeters);
        mounted.current = true;
      } else if (mounted.current) {
        removeRoostOverlay(map);
        mounted.current = false;
      }
    });
  }, [engine, renderer]);

  return null;
}

export function MapView() {
  const renderer = useMemo<TerraDraw2DRenderer>(
    () =>
      createTerraDraw2DRenderer({
        style: POSITRON_STYLE as never,
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
      <RoostOverlay renderer={renderer} />  
    </MapScene>
  );
}
