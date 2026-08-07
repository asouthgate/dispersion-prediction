import { describe, it, expect } from 'vitest';
import type { DataFeature } from '@gsbio/engine';
import { extractLampCoords, applyMask, encodeTotalResistance } from './resistancePipeline';
import { wgs84ToBng, bngToWgs84LngLat } from '../../utils/projections';

const EXTENT = {
  m: 100,
  n: 100,
  pixw: 10,
  xmin: 300000,
  ymin: 60000,
  xmax: 301000,
  ymax: 61000,
};

function pointFeature(lng: number, lat: number, height?: number): DataFeature {
  return {
    id: 'lamp-1',
    category: 'Lights',
    label: '',
    geometryKind: 'Point',
    visible: true,
    geojson: {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: {},
    },
    ...(height !== undefined ? { data: { height } } : {}),
  } as unknown as DataFeature;
}

function lineFeature(coords: [number, number][], height?: number, spacing?: number): DataFeature {
  const data: Record<string, number> = {};
  if (height !== undefined) data.height = height;
  if (spacing !== undefined) data.spacing = spacing;
  return {
    id: 'seq-1',
    category: 'LightSequence',
    label: '',
    geometryKind: 'LineString',
    visible: true,
    geojson: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {},
    },
    ...(Object.keys(data).length > 0 ? { data } : {}),
  } as unknown as DataFeature;
}

describe('extractLampCoords', () => {
  it('extracts a Point from Feature-shaped geojson (regression: coordinates nested under geometry)', () => {
    // Center of the extent: col 50, row 50
    const [lng, lat] = bngToWgs84LngLat(300500, 60500);
    const result = extractLampCoords([pointFeature(lng, lat, 6)], EXTENT);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
    expect(result![0]).toBeCloseTo(50, 1); // col
    expect(result![1]).toBeCloseTo(50, 1); // row
    expect(result![2]).toBe(6); // height
  });

  it('defaults height to 0 when not provided', () => {
    const [lng, lat] = bngToWgs84LngLat(300500, 60500);
    const result = extractLampCoords([pointFeature(lng, lat)], EXTENT);
    expect(result).not.toBeNull();
    expect(result![2]).toBe(0);
  });

  it('skips non-lamp geometries (Polygon) and returns null when nothing valid', () => {
    const poly = {
      id: 'p',
      category: 'Lights',
      label: '',
      geometryKind: 'Polygon',
      visible: true,
      geojson: {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
        },
        properties: {},
      },
    } as unknown as DataFeature;
    expect(extractLampCoords([poly], EXTENT)).toBeNull();
  });

  it('interpolates LightSequence LineString at spacing intervals', () => {
    // Build a 100m east-west segment in BNG, then convert endpoints to WGS84.
    const [lng1, lat1] = bngToWgs84LngLat(300100, 60050);
    const [lng2, lat2] = bngToWgs84LngLat(300200, 60050);
    const [e1, n1] = wgs84ToBng(lat1, lng1);
    const [e2, n2] = wgs84ToBng(lat2, lng2);
    const segLen = Math.sqrt((e2 - e1) ** 2 + (n2 - n1) ** 2);

    const spacing = 25;
    const expectedPoints = Math.max(1, Math.floor(segLen / spacing));

    const result = extractLampCoords([lineFeature([[lng1, lat1], [lng2, lat2]], 4, spacing)], EXTENT);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(expectedPoints * 3);
    for (let i = 0; i < expectedPoints; i++) {
      expect(result![i * 3 + 2]).toBe(4); // height on every interpolated point
    }
  });

  it('defaults LightSequence spacing to 50 when not provided', () => {
    const [lng1, lat1] = bngToWgs84LngLat(300100, 60050);
    const [lng2, lat2] = bngToWgs84LngLat(300300, 60050);
    const [e1, n1] = wgs84ToBng(lat1, lng1);
    const [e2, n2] = wgs84ToBng(lat2, lng2);
    const segLen = Math.sqrt((e2 - e1) ** 2 + (n2 - n1) ** 2);

    const result = extractLampCoords([lineFeature([[lng1, lat1], [lng2, lat2]])], EXTENT);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(Math.max(1, Math.floor(segLen / 50)) * 3);
  });

  it('produces at least one point for a very short segment', () => {
    const [lng1, lat1] = bngToWgs84LngLat(300100, 60050);
    const [lng2, lat2] = bngToWgs84LngLat(300105, 60050);
    const result = extractLampCoords([lineFeature([[lng1, lat1], [lng2, lat2]], 3, 1000)], EXTENT);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
  });

  it('combines points from multiple features', () => {
    const [lng1, lat1] = bngToWgs84LngLat(300500, 60500);
    const [lng2, lat2] = bngToWgs84LngLat(300600, 60600);
    const result = extractLampCoords([pointFeature(lng1, lat1, 5), pointFeature(lng2, lat2, 7)], EXTENT);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(6);
  });
});

describe('applyMask', () => {
  it('sets NaN where mask is 0 and preserves values where mask is 1', () => {
    const data = new Float32Array([1, 2, 3, 4]);
    const mask = new Uint8Array([1, 0, 1, 0]);
    const result = applyMask(data, mask);
    expect(result[0]).toBe(1);
    expect(Number.isNaN(result[1])).toBe(true);
    expect(result[2]).toBe(3);
    expect(Number.isNaN(result[3])).toBe(true);
  });

  it('does not mutate the input array', () => {
    const data = new Float32Array([1, 2, 3, 4]);
    const mask = new Uint8Array([0, 0, 0, 0]);
    applyMask(data, mask);
    expect(data[0]).toBe(1);
    expect(data[3]).toBe(4);
  });
});

describe('encodeTotalResistance', () => {
  it('round-trips Float32Array through base64 little-endian', () => {
    const values = [1.5, -2.5, 100.25];
    const res = {
      data: new Float32Array(values),
      extent: { m: 1, n: 3, pixw: 10, xmin: 0, ymin: 0, xmax: 30, ymax: 10 },
    };
    const encoded = encodeTotalResistance(res);
    expect(encoded.extent).toBe(res.extent);

    const raw = atob(encoded.data_base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const decoded = new Float32Array(bytes.buffer);
    for (let i = 0; i < values.length; i++) {
      expect(decoded[i]).toBeCloseTo(values[i], 5);
    }
  });
});
