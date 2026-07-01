"""Raster service: convert GeoTIFF to PNG for serving over HTTP."""

import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def _apply_circular_mask(rgba: "np.ndarray") -> "np.ndarray":
    """Clip an RGBA image array to a circle inscribed in the rectangle.
    Pixels outside the circle get alpha=0."""
    import numpy as np
    height, width = rgba.shape[:2]
    cy = height / 2.0
    cx = width / 2.0
    radius = min(width, height) / 2.0
    y, x = np.ogrid[:height, :width]
    mask = (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2
    rgba[mask, 3] = 0
    return rgba


def _pad_to_mercator_aspect(rgba: "np.ndarray", bounds: tuple[float, float, float, float]) -> "np.ndarray":
    """Pad an RGBA image so its pixel aspect ratio matches the Web Mercator
    aspect ratio of the geographic bounds.  Prevents MapLibre from stretching
    the image when it fits the image to the bounds rectangle."""
    import numpy as np
    from pyproj import Transformer

    transformer = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    west, south, east, north = bounds

    left_x, top_y = transformer.transform(west, north)
    right_x, bottom_y = transformer.transform(east, south)

    merc_w = right_x - left_x
    merc_h = top_y - bottom_y
    merc_ratio = merc_w / merc_h

    height, width = rgba.shape[:2]
    pixel_ratio = width / height

    if abs(pixel_ratio - merc_ratio) < 0.001:
        return rgba

    if pixel_ratio > merc_ratio:
        new_height = int(width / merc_ratio)
        pad_top = (new_height - height) // 2
        pad_bottom = new_height - height - pad_top
        rgba = np.pad(rgba, ((pad_top, pad_bottom), (0, 0), (0, 0)),
                      mode="constant", constant_values=0)
    else:
        new_width = int(height * merc_ratio)
        pad_left = (new_width - width) // 2
        pad_right = new_width - width - pad_left
        rgba = np.pad(rgba, ((0, 0), (pad_left, pad_right), (0, 0)),
                      mode="constant", constant_values=0)

    return rgba


def tif_to_png(tif_path: str, png_path: str, bounds: Optional[tuple[float, float, float, float]] = None,
               circular_mask: bool = True, colormap: str = "magma") -> tuple[int, int, tuple[float, float, float, float]]:
    """Convert a GeoTIFF to PNG, returning (width, height, bounds).

    Returns bounds as [west, south, east, north] in EPSG:4326.
    When circular_mask is True, the image is clipped to a circle
    inscribed in the bounding box (matching the roost radius).

    Args:
        tif_path: path to input GeoTIFF
        png_path: path to output PNG
        bounds: optional bounds tuple for the PNG
        circular_mask: whether to apply a circular mask
        colormap: matplotlib colormap name (e.g. "magma", "terrain", "tab20")
    """
    import numpy as np
    import rasterio

    with rasterio.open(tif_path) as src:
        left, bottom, right, top = src.bounds

        if bounds is None:
            from pyproj import Transformer
            transformer = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
            west, south = transformer.transform(left, bottom)
            east, north = transformer.transform(right, top)
            bounds = (west, south, east, north)

        data = src.read(1)

        nodata_val = src.nodata
        if nodata_val is not None:
            valid = data != nodata_val
        else:
            valid = np.ones_like(data, dtype=bool)

        if not np.all(valid):
            data = data.copy()
            data[~valid] = np.nan

        vmin = np.nanmin(data) if np.nanmin(data) != np.nanmax(data) else 0
        vmax = np.nanmax(data) if np.nanmin(data) != np.nanmax(data) else 1
        if vmax == vmin:
            vmax = vmin + 1

        normalized = np.clip((data - vmin) / (vmax - vmin) * 255, 0, 255).astype(np.uint8)

        from matplotlib import colormaps
        cmap = colormaps.get_cmap(colormap)
        rgba = cmap(normalized / 255.0)
        rgba = (rgba * 255).astype(np.uint8)

        if valid is not None:
            rgba[~valid, 3] = 0

        if circular_mask:
            rgba = _pad_to_mercator_aspect(rgba, bounds)
            _apply_circular_mask(rgba)

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
