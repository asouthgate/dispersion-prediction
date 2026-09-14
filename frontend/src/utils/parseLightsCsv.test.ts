import { describe, it, expect } from 'vitest';
import { parseLightsCsv } from './parseLightsCsv';
import { bngToWgs84LngLat } from './projections';

describe('parseLightsCsv', () => {
  it('parses lat/lng columns with height', () => {
    const csv = 'lat,lng,height\n50.604,-3.59,10\n50.605,-3.591,8';
    const { geojson, count } = parseLightsCsv(csv);
    expect(count).toBe(2);
    const g = geojson.features[0]!.geometry as GeoJSON.MultiPoint;
    expect(g.type).toBe('MultiPoint');
    expect(g.coordinates).toEqual([[-3.59, 50.604], [-3.591, 50.605]]);
    expect(geojson.features[0]!.properties!.heights).toEqual([10, 8]);
  });

  it('reprojects easting/northing (BNG) to WGS84', () => {
    const easting = 300500;
    const northing = 60500;
    const [lng, lat] = bngToWgs84LngLat(easting, northing);
    const csv = `easting,northing,height\n${easting},${northing},7`;
    const { geojson } = parseLightsCsv(csv);
    const g = geojson.features[0]!.geometry as GeoJSON.MultiPoint;
    expect(g.coordinates[0]![0]).toBeCloseTo(lng, 9);
    expect(g.coordinates[0]![1]).toBeCloseTo(lat, 9);
  });

  it('throws when neither lat/lng nor easting/northing columns exist', () => {
    expect(() => parseLightsCsv('x,y,z\n1,2,3')).toThrow(/lat\/lng|easting\/northing/);
  });

  it('handles quoted fields and CRLF line endings', () => {
    const csv = '"lat","lng","height"\r\n"50.604","-3.59","10"\r\n';
    const { count } = parseLightsCsv(csv);
    expect(count).toBe(1);
  });

  it('throws when the height column is missing', () => {
    expect(() => parseLightsCsv('lat,lng\n50.604,-3.59')).toThrow(/height column/i);
  });

  it('warns when lamp heights are unrealistic', () => {
    const csv = 'lat,lng,height\n50.604,-3.59,10\n50.605,-3.591,397157';
    const { warnings } = parseLightsCsv(csv);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/unrealistic height/i);
  });

  it('warns when lat/lng are out of range (e.g. BNG values in lat/lng columns)', () => {
    const csv = 'lat,lng,height\n397157,87896,7';
    const { warnings } = parseLightsCsv(csv);
    expect(warnings.some((w) => /outside the valid range/i.test(w))).toBe(true);
  });

  it('throws when no valid coordinates are present', () => {
    expect(() => parseLightsCsv('lat,lng,height\nfoo,bar,10')).toThrow(/no valid lamp coordinates/i);
  });
});
