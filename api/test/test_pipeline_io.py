"""Tests for the square-grid guard in raster metadata collection."""

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_bounds

from services.pipeline_io import collect_raster_info


def _write_tif(path, transform, width, height):
    with rasterio.open(
        path, "w", driver="GTiff", height=height, width=width,
        count=1, dtype="float32", crs="EPSG:27700",
        transform=transform, nodata=-9999.0,
    ) as dst:
        dst.write(np.zeros((height, width), dtype=np.float32), 1)


def test_collect_raster_info_raises_on_non_square_grid(tmp_path):
    # X pixel 10m, Y pixel 7m -> non-square.
    transform = from_bounds(297500, 299000, 302500, 302500, 500, 500)
    _write_tif(tmp_path / "dtm.tif", transform, 500, 500)

    with pytest.raises(RuntimeError, match="Non-square raster grid"):
        collect_raster_info(str(tmp_path))


def test_collect_raster_info_returns_square_grid(tmp_path):
    transform = from_bounds(297500, 297500, 302500, 302500, 500, 500)
    _write_tif(tmp_path / "dtm.tif", transform, 500, 500)

    info = collect_raster_info(str(tmp_path))

    assert info is not None
    assert info["m"] == 500
    assert info["n"] == 500
    assert info["pixw"] == pytest.approx(10.0)
    assert info["xmin"] == pytest.approx(297500)
    assert info["ymax"] == pytest.approx(302500)
