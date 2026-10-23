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
  STYLE_TEMPLATE,
  resolvePaletteTokens,
  type MapPalette,
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
import { Move } from 'react-coolicons';
import { Triangle, Circle } from 'react-coolicons';
import { getStoredToken, acquireToken, clearToken } from '../auth';
import { RoostResultLegend } from './RoostResultLegend';

const CENTER: [number, number] = [-1.1581, 52.9548];
const ZOOM = 6;
/** Map zoom limits — the `uk.pmtiles` archive only carries z0-14 vector tiles (overscaled above 14). */
const MIN_ZOOM = 0;
const MAX_ZOOM = 20;
const MAX_BOUNDS: [[number, number], [number, number]] = [[-14, 49.5], [11, 61.5]];

const API_BASE = '/api';
const PMTILES_FILENAME = 'uk.pmtiles';

/** For vector map data */
const MAP_PALETTE: MapPalette = {
  background: '#405c52',
  land: '#31524b',
  land_green: '#405c52',
  water: '#1f2b30',
  road_casing: '#7a735c',
  road_fill: '#7a735c',
  road_tunnel_fill: '#7a735c',
  building: '#7a735c',
  label_main: '#ffffff',
  label_minor: '#ffffff',
  label_halo: '#ffffff',
  rail: '#618a8d',
  border: '#9e9cab00',
  aeroway: '#918678',
};

const iconStyle = { width: 18, height: 18 };

type ToolDef = { mode: DrawMode; label: string; icon: React.ReactNode; color: string; category?: string; options?: Record<string, unknown>; fillOpacity?: number };

const ROOST_COLOR = '#ffe70a';

const TOOLS: ToolDef[] = [
  { mode: 'select', label: 'Select', icon: <Move style={iconStyle} />, color: '#888' },
  { mode: 'circle', label: 'Roost', icon: <Circle style={iconStyle} />, color: ROOST_COLOR, options: { maxRadiusMeters: 5000 }, fillOpacity: 0 },
  { mode: 'polygon', label: 'Building', icon: <Building04 style={iconStyle} />, color: '#a0522d' },
  { mode: 'linestring', label: 'Road', icon: <CarAuto style={iconStyle} />, color: '#888888' },
  { mode: 'linestring', label: 'River', icon: <WaterDrop style={iconStyle} />, color: '#3678b5' },
  { mode: 'point', label: 'Lights', icon: <Sun style={iconStyle} />, color: '#ffbd17' },
  { mode: 'polygon', label: 'Zone', icon: <Triangle style={iconStyle} />, color: '#cc4444', category: 'GenericResistance' },
];

const drawTools: DrawTool[] = TOOLS.map((t) => ({ mode: t.mode, label: t.label, icon: t.icon as never, category: t.category, options: t.options }));

const Feature_OPACITY = 0.2;

const featureStyles: FeatureStyleConfig = {
  selectionColor: readAccentColor(),
  tools: [
    ...TOOLS.map((t) => {
      const base = { fillColor: t.color, fillOpacity: t.fillOpacity ?? Feature_OPACITY, outlineColor: t.color, outlineWidth: 2 };
      switch (t.mode) {
        case 'point':
          return { mode: t.mode, category: t.category ?? t.label, style: { pointColor: t.color, pointOutlineColor: '#0a0e10', pointRadius: 1 } };
        case 'circle':
          return { mode: t.mode, category: t.category ?? t.label, style: { ...base, outlineWidth: 4 }, options: t.options };
        case 'linestring':
          return { mode: t.mode, category: t.category ?? t.label, style: { lineColor: t.color, lineWidth: 2 } };
        case 'polygon':
          return { mode: t.mode, category: t.category ?? t.label, style: { ...base } };
        default:
          return { mode: t.mode, category: t.category ?? t.label, style: base };
      }
    }),
    { mode: 'polygon', category: 'LightMap', style: { fillColor: '#ffbd17', fillOpacity: 0.15, outlineColor: '#ffbd17', outlineWidth: 2 } },
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
const CROSS_COLOR = ROOST_COLOR;
const RECT_LINE_WIDTH = 2;
const CROSS_LINE_WIDTH = 1;

function readAccentColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
}

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

function createRoostLayers(map: any, color: string) {
  const beforeId = map.getStyle().layers.find((l: { id: string }) => l.id.startsWith('td-'))?.id;
  map.addLayer({ id: ROOST_RECT_FILL, type: 'fill', source: ROOST_RECT_SOURCE, paint: { 'fill-color': color, 'fill-opacity': 0.04 } }, beforeId);
  map.addLayer({ id: ROOST_RECT_LINE, type: 'line', source: ROOST_RECT_SOURCE, paint: { 'line-color': color, 'line-width': RECT_LINE_WIDTH } }, beforeId);
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
  const roostColor = ROOST_COLOR;

  /** Ensure that there is only one roost */
  useEffect(() => {
    let cleaning = false;
    return engine.subscribe(() => {
      if (cleaning) return;
      const features = engine.getSnapshot().features.features;
      const roosts = features.filter((f: DataFeature) => f.category === 'Roost');
      if (roosts.length > 1) {
        cleaning = true;
        try {
          for (const r of roosts.slice(0, -1)) {
            engine.removeFeature(r.id);
          }
        } finally {
          cleaning = false;
        }
      }
    });
  }, [engine]);

  useEffect(() => {
    const syncOverlay = () => {
      const map = renderer.getMap();
      if (!map) return;
      const roost = engine.getSnapshot().features.features.find((f: DataFeature) => f.category === 'Roost');
      if (roost?.circle) {
        const { center, radiusMeters } = roost.circle;
        const key = `${center.lng.toFixed(8)},${center.lat.toFixed(8)},${radiusMeters}`;
        const complete = map.getSource(ROOST_RECT_SOURCE) && map.getSource(ROOST_CROSS_SOURCE)
          && map.getLayer(ROOST_RECT_FILL) && map.getLayer(ROOST_RECT_LINE) && map.getLayer(ROOST_CROSS_LINE);
        if (key === lastKey.current && complete) return;
        if (!complete) {
          destroyRoostLayers(map);
          map.addSource(ROOST_RECT_SOURCE, { type: 'geojson', data: { type: 'Feature', geometry: rectGeom(center, radiusMeters), properties: {} } });
          map.addSource(ROOST_CROSS_SOURCE, { type: 'geojson', data: { type: 'Feature', geometry: crosshairGeom(center, radiusMeters), properties: {} } });
          createRoostLayers(map, roostColor);
        } else {
          setRoostData(map, center, radiusMeters);
        }
        lastKey.current = key;
      } else if (lastKey.current !== null) {
        lastKey.current = null;
        destroyRoostLayers(map);
      }
    };
    syncOverlay();
    return engine.subscribe(syncOverlay);
  }, [engine, renderer, roostColor]);

  return null;
}

export function MapView() {
  const renderer = useMemo<TerraDraw2DRenderer>(() => {
    return createTerraDraw2DRenderer({
      style: createPmtilesStyle(resolvePaletteTokens(STYLE_TEMPLATE, MAP_PALETTE), `${API_BASE}/pmtiles/${PMTILES_FILENAME}`),
      center: CENTER,
      zoom: ZOOM,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      maxBounds: MAX_BOUNDS,
      featureStyles,
      resultStyles,
      getToken: () => acquireToken(),
      refreshToken: () => { clearToken(); return acquireToken().catch(() => null); },
      transformRequest: (url: string) => {
        const pathname = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0];
        if (pathname.startsWith('/api/')) {
          const token = getStoredToken();
          return { url, headers: token ? { Authorization: `Bearer ${token}` } : {} };
        }
        return { url };
      },
      defaultData: {
        Building:           { height: 10 },
        Lights:             { height: 10 },
        LightSequence:      { height: 10, spacing: 50 },
        GenericResistance:  { resistanceValue: 100 },
      },
    });
  }, []);

  return (
    <MapScene renderer={renderer}>
      <DrawToolbar tools={drawTools} />
      <RoostResultLegend renderer={renderer} />
      <RoostOverlay renderer={renderer} />{/* Renders a roost-crosshair overlay that enforces single-roost semantics: uses
a `cleaning` flag to suppress re-entrant callbacks while removing extra roosts. */}
    </MapScene>
  );
}
