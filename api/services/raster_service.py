import logging
from typing import Optional

logger = logging.getLogger(__name__)


def get_bounds_for_tif(tif_path: str) -> tuple[float, float, float, float]:
    """Return native [xmin, ymin, xmax, ymax] bounds in EPSG:27700 for a GeoTIFF."""
    import rasterio

    with rasterio.open(tif_path) as src:
        left, bottom, right, top = src.bounds
        return (left, bottom, right, top)
