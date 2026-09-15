export {
  wgs84ToBng,
  bngToWgs84LngLat,
  bngExtentToWgs84Corners,
} from '@gsbio/engine';

export function formatCoord(n: number): string {
  if (n == null || isNaN(n)) return '';
  return n.toFixed(0);
}
