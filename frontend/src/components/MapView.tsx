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
import { Loading } from 'react-coolicons';
import { Triangle } from 'react-coolicons';
import { getStoredToken, acquireToken, clearToken } from '../auth';

const CENTER: [number, number] = [-3.590523, 50.586362];
const ZOOM = 13;
/** Map zoom limits — the `uk.pmtiles` archive only carries z0-14 vector tiles (overscaled above 14). */
const MIN_ZOOM = 0;
const MAX_ZOOM = 20;
const MAX_BOUNDS: [[number, number], [number, number]] = [[-14, 49.5], [4, 61.5]];

const API_BASE = '/api';
const PMTILES_FILENAME = 'uk.pmtiles';

/** For vector map data */
const MAP_PALETTE: MapPalette = {
  background: 'rgba(63, 72, 62, 1)',
  land: 'rgba(55, 83, 76, 1)',
  land_green: '#243b3e',
  water: 'rgba(78, 122, 202, 1)',
  road_casing: '#353948',
  road_fill: '#353948',
  road_tunnel_fill: '#353948',
  building: '#545961',
  label_main: 'rgba(224, 224, 224, 1)',
  label_minor: 'rgba(224, 224, 224, 1)',
  label_halo: 'rgba(255, 255, 255, 0.7)',
  rail: '#618a8d',
  border: '#9e9cab00',
  aeroway: '#918678',
};

const iconStyle = { width: 18, height: 18 };

type ToolDef = { mode: DrawMode; label: string; icon: React.ReactNode; color: string; category?: string; maxRadiusMeters?: number };

const TOOLS: ToolDef[] = [
  { mode: 'select', label: 'Select', icon: <Move style={iconStyle} />, color: '#888' },
  { mode: 'circle', label: 'Roost', icon: '◉', color: '#5b8def', maxRadiusMeters: 5000 },
  { mode: 'polygon', label: 'Building', icon: <Building04 style={iconStyle} />, color: '#a0522d' },
  { mode: 'linestring', label: 'Road', icon: <CarAuto style={iconStyle} />, color: '#888888' },
  { mode: 'linestring', label: 'River', icon: <WaterDrop style={iconStyle} />, color: '#3678b5' },
  { mode: 'point', label: 'Lights', icon: <Sun style={iconStyle} />, color: '#ffbd17' },
  { mode: 'linestring', label: 'Light Sequence', icon: <Loading style={iconStyle} />, color: '#ff9900', category: 'LightSequence' },
  { mode: 'polygon', label: 'Resistance Zone', icon: <Triangle style={iconStyle} />, color: '#cc4444', category: 'GenericResistance' },
];

const drawTools: DrawTool[] = TOOLS.map((t) => ({ mode: t.mode, label: t.label, icon: t.icon as never, category: t.category, maxRadiusMeters: t.maxRadiusMeters }));

const Feature_OPACITY = 0.2;

const featureStyles: FeatureStyleConfig = {
  tools: [
    ...TOOLS.map((t) => {
      const base = { fillColor: t.color, fillOpacity: Feature_OPACITY, outlineColor: t.color, outlineWidth: 2 };
      switch (t.mode) {
        case 'point':
          return { mode: t.mode, category: t.category ?? t.label, style: { pointColor: t.color, pointOutlineColor: '#0a0e10', pointRadius: 7 } };
        case 'circle':
          return { mode: t.mode, category: t.category ?? t.label, style: { ...base }, maxRadiusMeters: t.maxRadiusMeters };
        case 'linestring':
          return { mode: t.mode, category: t.category ?? t.label, style: { lineColor: t.color, lineWidth: 2 } };
        case 'polygon':
          return { mode: t.mode, category: t.category ?? t.label, style: { ...base } };
        default:
          return { mode: t.mode, category: t.category ?? t.label, style: base };
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
const CROSS_COLOR = '#999';
const RECT_LINE_WIDTH = 1;
const CROSS_LINE_WIDTH = 0.5;

function readAccentColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#5b8def';
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
  const accentColor = readAccentColor();

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
          createRoostLayers(map, accentColor);
        } else {
          setRoostData(map, center, radiusMeters);
        }
      } else if (lastKey.current !== null) {
        lastKey.current = null;
        destroyRoostLayers(map);
      }
    });
  }, [engine, renderer, accentColor]);

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
      transformRequest: (url) => {
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
      <RoostOverlay renderer={renderer} />{/* Renders a roost-crosshair overlay that enforces single-roost semantics: uses
a `cleaning` flag to suppress re-entrant callbacks while removing extra roosts. */}
    </MapScene>
  );
}
