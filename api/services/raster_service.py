"""Raster helpers.

Rendering (colormaps, colorbars, circular masks) now happens client-side in the
shared frontend plotter, so this module only exposes the georeferencing helper
needed to describe rasters in API responses.
"""

import logging
from typing import Optional

logger = logging.getLogger(__name__)


def get_bounds_for_tif(tif_path: str) -> tuple[float, float, float, float]:
    """Return [west, south, east, north] bounds in EPSG:4326 for a GeoTIFF."""
    import rasterio
    from pyproj import Transformer

    with rasterio.open(tif_path) as src:
        left, bottom, right, top = src.bounds
        transformer = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
        west, south = transformer.transform(left, bottom)
        east, north = transformer.transform(right, top)
        return (west, south, east, north)
