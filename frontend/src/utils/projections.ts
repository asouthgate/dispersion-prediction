import proj4 from 'proj4';

const WGS84 = 'EPSG:4326';
const BNG = '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.247,0.8421,-20.4894 +units=m +no_defs';

export function wgs84ToBng(lat: number, lon: number): [number, number] {
  const [easting, northing] = proj4(WGS84, BNG, [lon, lat]);
  return [easting, northing];
}

export function bngToWgs84(easting: number, northing: number): [number, number] {
  const [lon, lat] = proj4(BNG, WGS84, [easting, northing]);
  return [lat, lon];
}

export function bngToWgs84LngLat(easting: number, northing: number): [number, number] {
  const [lng, lat] = proj4(BNG, WGS84, [easting, northing]);
  return [lng, lat];
}

export function formatCoord(n: number): string {
  if (n == null || isNaN(n)) return '';
  return n.toFixed(0);
}
