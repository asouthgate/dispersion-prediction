"""Raster service: convert GeoTIFF to PNG for serving over HTTP."""

import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def tif_to_png(tif_path: str, png_path: str, bounds: Optional[tuple[float, float, float, float]] = None) -> tuple[int, int, tuple[float, float, float, float]]:
    """Convert a GeoTIFF to PNG, returning (width, height, bounds).

    Returns bounds as [west, south, east, north] in EPSG:4326.
    """
    import rasterio

    with rasterio.open(tif_path) as src:
        # Get bounds in source CRS (BNG)
        left, bottom, right, top = src.bounds

        if bounds is None:
            # Convert BNG bounds to WGS84
            from pyproj import Transformer
            transformer = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
            west, south = transformer.transform(left, bottom)
            east, north = transformer.transform(right, top)
            bounds = (west, south, east, north)

        data = src.read(1)

        # Normalize to 0-255 for PNG
        import numpy as np
        valid = ~src.nodata if src.nodata is not None else np.ones_like(data, dtype=bool)

        if valid is not None and not np.all(valid):
            data = data.copy()
            data[~valid] = np.nan

        vmin = np.nanmin(data) if np.nanmin(data) != np.nanmax(data) else 0
        vmax = np.nanmax(data) if np.nanmin(data) != np.nanmax(data) else 1
        if vmax == vmin:
            vmax = vmin + 1

        normalized = np.clip((data - vmin) / (vmax - vmin) * 255, 0, 255).astype(np.uint8)

        # Apply inferno colormap for resistance/current maps
        from matplotlib import colormaps
        cmap = colormaps.get_cmap("inferno")
        rgba = cmap(normalized / 255.0)
        rgba = (rgba * 255).astype(np.uint8)

        # Set nodata pixels to transparent
        if valid is not None:
            rgba[~valid, 3] = 0

        import numpy
        height, width = data.shape

        from PIL import Image
        img = Image.fromarray(rgba, "RGBA")
        os.makedirs(os.path.dirname(png_path), exist_ok=True)
        img.save(png_path, "PNG")

        return width, height, bounds


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


def create_zip_archive(file_paths: list[str], zip_path: str) -> None:
    """Create a ZIP archive of the given files."""
    import zipfile
    os.makedirs(os.path.dirname(zip_path), exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for fp in file_paths:
            zf.write(fp, os.path.basename(fp))
