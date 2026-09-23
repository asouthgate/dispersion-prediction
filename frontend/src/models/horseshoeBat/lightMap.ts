import type { DecodedRaster } from '@gsbio/engine';
import { bngExtentToWgs84Corners } from '@gsbio/engine';

/** Feature category under which an imported light map is stored. */
export const LIGHTMAP_CATEGORY = 'LightMap';

export const LIGHTMAP_LABEL = 'Light map';

/** The decoded light map stored on the feature's `data.raster`. */
export type LightMapData = DecodedRaster;

/**
 * Build a WGS84 polygon footprint for a decoded light map, used to render the
 * imported raster on the map. BNG bounds are projected to their four corners
 * (preserving grid rotation); WGS84 bounds are used directly.
 */
export function lightMapFootprint(decoded: DecodedRaster): GeoJSON.Polygon {
  const [xmin, ymin, xmax, ymax] = decoded.bounds;
  const corners: [number, number][] = decoded.crs === 'EPSG:27700'
    ? bngExtentToWgs84Corners([xmin, ymin, xmax, ymax])
    : [[xmin, ymax], [xmax, ymax], [xmax, ymin], [xmin, ymin]];
  return { type: 'Polygon', coordinates: [[...corners, corners[0]]] };
}
