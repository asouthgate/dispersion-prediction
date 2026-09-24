"""Tests for raster fetching and square-grid normalisation."""

import os

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_bounds

from services.data_fetch import (
    NODATA,
    fetch_raster_stack,
    resample_to_grid,
    target_square_grid,
)


def test_target_square_grid_is_square_and_anchored():
    ncols, nrows, transform = target_square_grid(297500, 297500, 302500, 302500, 10)

    assert ncols == nrows == 500
    # Square pixels: x and y pixel sizes are equal (y is negative for north-up).
    assert transform.a == pytest.approx(-transform.e)
    assert transform.a == pytest.approx(10.0)
    # Anchored exactly on the requested extent.
    assert transform.c == pytest.approx(297500)
    assert transform.f == pytest.approx(302500)


def test_resample_to_grid_normalises_non_square_source():
    ncols = nrows = 500
    # Source covers the full width but only the northern part (truncated south):
    # x [297500, 302500], y [299000, 302500] -> non-square pixels (10m x 7m).
    src_transform = from_bounds(297500, 299000, 302500, 302500, ncols, nrows)
    values = np.ones((nrows, ncols), dtype=np.float32)

    # Target: the full square requested extent.
    dst_ncols, dst_nrows, dst_transform = target_square_grid(297500, 297500, 302500, 302500, 10)
    out = resample_to_grid(values, src_transform, dst_transform, dst_ncols, dst_nrows)

    assert out.shape == (dst_nrows, dst_ncols)
    # Overlapping region keeps the source value.
    assert out[0, 0] == pytest.approx(1.0)
    # Region south of the source coverage is nodata-padded, not garbage.
    assert out[-1, -1] == pytest.approx(NODATA)


def test_fetch_raster_stack_writes_square_tif(tmp_path, monkeypatch):
    extent = (297500, 297500, 302500, 302500)
    resolution = 10
    ncols = nrows = 500
    # Simulate a truncated (non-square) DB fetch: data only covers y >= 299000.
    src_envelope = (297500, 299000, 302500, 302500)
    values = np.ones((nrows, ncols), dtype=np.float32)

    def fake_query(conn, table, xmin, ymin, xmax, ymax, nc, nr):
        return values, src_envelope

    monkeypatch.setattr("services.data_fetch.query_raster_values", fake_query)

    transform, out_ncols, out_nrows = fetch_raster_stack(
        object(), str(tmp_path), [("dtm", "dtm")], extent, resolution,
    )

    assert out_ncols == out_nrows == ncols
    # The grid returned (and written) is square.
    assert transform.a == pytest.approx(-transform.e)

    with rasterio.open(os.path.join(str(tmp_path), "dtm.tif")) as src:
        assert src.transform.a == pytest.approx(-src.transform.e)
        assert src.bounds.left == pytest.approx(extent[0])
        assert src.bounds.bottom == pytest.approx(extent[1])
        assert src.bounds.right == pytest.approx(extent[2])
        assert src.bounds.top == pytest.approx(extent[3])

        data = src.read(1)
        assert data[0, 0] == pytest.approx(1.0)
        assert data[-1, -1] == pytest.approx(NODATA)
