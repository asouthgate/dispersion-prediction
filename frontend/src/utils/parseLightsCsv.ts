import { bngToWgs84LngLat } from './projections';

export interface ParsedLights {
  geojson: GeoJSON.FeatureCollection;
  count: number;
}

const LAT_ALIASES = new Set(['lat', 'latitude']);
const LNG_ALIASES = new Set(['lng', 'lon', 'long', 'longitude']);
const EASTING_ALIASES = new Set(['easting']);
const NORTHING_ALIASES = new Set(['northing']);
const HEIGHT_ALIASES = new Set(['height', 'z']);

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Parses a street-lamp CSV into a single GeoJSON MultiPoint FeatureCollection.
 *
 * Coordinates must be provided as a lat/lng pair (`lat`/`latitude` +
 * `lng`/`lon`/`long`/`longitude`) or an easting/northing pair (`easting` +
 * `northing`, British National Grid). An optional `height` (or `z`) column
 * supplies per-lamp heights. Headers are matched case-insensitively.
 */
export function parseLightsCsv(text: string): ParsedLights {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new Error('CSV is empty.');
  }

  const header = rows[0]!.map(normalizeHeader);

  const findIndex = (aliases: Set<string>): number | null => {
    const idx = header.findIndex((h) => aliases.has(h));
    return idx === -1 ? null : idx;
  };

  const latIdx = findIndex(LAT_ALIASES);
  const lngIdx = findIndex(LNG_ALIASES);
  const eastingIdx = findIndex(EASTING_ALIASES);
  const northingIdx = findIndex(NORTHING_ALIASES);
  const heightIdx = findIndex(HEIGHT_ALIASES);

  const isWgs84 = latIdx !== null && lngIdx !== null;
  const isBng = eastingIdx !== null && northingIdx !== null;

  if (!isWgs84 && !isBng) {
    throw new Error(
      'CSV must include a lat/lng pair (lat, lng) or an easting/northing pair (easting, northing).',
    );
  }

  const coordinates: [number, number][] = [];
  const heights: number[] = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    if (cells.length === 0) continue;

    const parseNum = (idx: number | null): number => {
      if (idx === null) return NaN;
      return Number.parseFloat(cells[idx] ?? '');
    };

    const height = heightIdx !== null ? parseNum(heightIdx) : 0;
    const h = Number.isFinite(height) ? height : 0;

    let lng: number;
    let lat: number;

    if (isWgs84) {
      lat = parseNum(latIdx!);
      lng = parseNum(lngIdx!);
    } else {
      const easting = parseNum(eastingIdx!);
      const northing = parseNum(northingIdx!);
      if (!Number.isFinite(easting) || !Number.isFinite(northing)) continue;
      [lng, lat] = bngToWgs84LngLat(easting, northing);
    }

    if (!Number.isFinite(lng!) || !Number.isFinite(lat!)) continue;

    coordinates.push([lng, lat]);
    heights.push(h);
  }

  if (coordinates.length === 0) {
    throw new Error('CSV contains no valid lamp coordinates.');
  }

  return {
    geojson: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'MultiPoint', coordinates },
          properties: { heights },
        },
      ],
    },
    count: coordinates.length,
  };
}
