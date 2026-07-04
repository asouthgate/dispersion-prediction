import { useEffect, useMemo, useRef } from 'react';
import type { DrawMode } from '@gsbio/engine';
import {
  MapScene,
  DrawToolbar,
  type DrawTool,
  useEngine,
  type DataFeature,
  destinationPoint,
  createPmtilesStyle,
  OSM_LIBERTY_STYLE,
} from '@gsbio/engine';
import {
  createTerraDraw2DRenderer,
  type TerraDraw2DRenderer,
  type FeatureStyleConfig,
  type ResultPaint,
} from '@gsbio/engine';
import { Building04 } from 'react-coolicons';
import { CarAuto } from 'react-coolicons';
import { WaterDrop } from 'react-coolicons';
import { Sun } from 'react-coolicons';
import { getTokenSync, ensureValidToken } from '../auth';

const CENTER: [number, number] = [-3.590523, 50.586362];
const ZOOM = 13;
/** Map zoom limits — the `uk.pmtiles` archive only carries z0-14 vector tiles. */
const MIN_ZOOM = 0;
const MAX_ZOOM = 14;

const API_BASE = '/api';
const PMTILES_FILENAME = 'uk.pmtiles';

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

const ROOST_RECT_SOURCE = 'roost-rect';
const ROOST_CROSS_SOURCE = 'roost-cross';
const ROOST_RECT_FILL = 'roost-rect-fill';
const ROOST_RECT_LINE = 'roost-rect-line';
const ROOST_CROSS_LINE = 'roost-cross-line';
const ROOST_COLOR = '#1a1a1a';
const CROSS_COLOR = '#999';
const RECT_LINE_WIDTH = 1;
const CROSS_LINE_WIDTH = 0.5;

function cardinal(p: { lng: number; lat: number }, r: number, bearing: number) { return destinationPoint(p, r, bearing); }

function rectGeom(center: { lng: number; lat: number }, radius: number): GeoJSON.Geometry {
  const nw = [cardinal(center, radius, 270).lng, cardinal(center, radius, 0).lat];
  const ne = [cardinal(center, radius, 90).lng, cardinal(center, radius, 0).lat];
  const se = [cardinal(center, radius, 90).lng, cardinal(center, radius, 180).lat];
  const sw = [cardinal(center, radius, 270).lng, cardinal(center, radius, 180).lat];
  return { type: 'Polygon', coordinates: [[nw, ne, se, sw, nw] as [number, number][]] };
}

function crosshairGeom(center: { lng: number; lat: number }, radius: number): GeoJSON.Geometry {
  const N = cardinal(center, radius, 0);
  const E = cardinal(center, radius, 90);
  const S = cardinal(center, radius, 180);
  const W = cardinal(center, radius, 270);
  return {
    type: 'MultiLineString',
    coordinates: [
      [[W.lng, center.lat], [E.lng, center.lat]],
      [[center.lng, S.lat], [center.lng, N.lat]],
    ],
  };
}

function createRoostLayers(map: any) {
  const beforeId = map.getStyle().layers.find((l: { id: string }) => l.id.startsWith('td-'))?.id;
  map.addLayer({ id: ROOST_RECT_FILL, type: 'fill', source: ROOST_RECT_SOURCE, paint: { 'fill-color': ROOST_COLOR, 'fill-opacity': 0.04 } }, beforeId);
  map.addLayer({ id: ROOST_RECT_LINE, type: 'line', source: ROOST_RECT_SOURCE, paint: { 'line-color': ROOST_COLOR, 'line-width': RECT_LINE_WIDTH } }, beforeId);
  map.addLayer({ id: ROOST_CROSS_LINE, type: 'line', source: ROOST_CROSS_SOURCE, paint: { 'line-color': CROSS_COLOR, 'line-width': CROSS_LINE_WIDTH } }, beforeId);
}

function setRoostData(map: any, center: { lng: number; lat: number }, radius: number) {
  const src = map.getSource(ROOST_RECT_SOURCE);
  if (src) src.setData({ type: 'Feature' as const, geometry: rectGeom(center, radius), properties: {} });
  const cross = map.getSource(ROOST_CROSS_SOURCE);
  if (cross) cross.setData({ type: 'Feature' as const, geometry: crosshairGeom(center, radius), properties: {} });
}

function destroyRoostLayers(map: any) {
  try { map.removeLayer(ROOST_CROSS_LINE); } catch {}
  try { map.removeLayer(ROOST_RECT_LINE); } catch {}
  try { map.removeLayer(ROOST_RECT_FILL); } catch {}
  try { map.removeSource(ROOST_CROSS_SOURCE); } catch {}
  try { map.removeSource(ROOST_RECT_SOURCE); } catch {}
}

function RoostOverlay({ renderer }: { renderer: TerraDraw2DRenderer }) {
  const engine = useEngine();
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    return engine.subscribe(() => {
      const map = renderer.getMap();
      if (!map) return;
      const roost = engine.getSnapshot().features.features.find((f: DataFeature) => f.category === 'Roost');
      if (roost?.circle) {
        const { center, radiusMeters } = roost.circle;
        const key = `${center.lng.toFixed(8)},${center.lat.toFixed(8)},${radiusMeters}`;
        if (key === lastKey.current) return;
        const existed = lastKey.current !== null;
        lastKey.current = key;
        if (!existed) {
          map.addSource(ROOST_RECT_SOURCE, { type: 'geojson', data: { type: 'Feature', geometry: rectGeom(center, radiusMeters), properties: {} } });
          map.addSource(ROOST_CROSS_SOURCE, { type: 'geojson', data: { type: 'Feature', geometry: crosshairGeom(center, radiusMeters), properties: {} } });
          createRoostLayers(map);
        } else {
          setRoostData(map, center, radiusMeters);
        }
      } else if (lastKey.current !== null) {
        lastKey.current = null;
        destroyRoostLayers(map);
      }
    });
  }, [engine, renderer]);

  return null;
}

export function MapView() {
  const renderer = useMemo<TerraDraw2DRenderer>(() => {
    return createTerraDraw2DRenderer({
      style: createPmtilesStyle(OSM_LIBERTY_STYLE, `${API_BASE}/pmtiles/${PMTILES_FILENAME}`),
      center: CENTER,
      zoom: ZOOM,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      featureStyles,
      resultStyles,
      getToken: getTokenSync,
      refreshToken: () => ensureValidToken(true),
    });
  }, []);

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
