"""Tests for total_resistance validation"""

import base64
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
from tasks import _write_total_resistance_raster
from routers.pipeline import _valid_dim
from services.pipeline_io import wgs84_to_bng

class TotalResistanceTests(unittest.TestCase):

    def test_size_mismatch_raises(self):

        total_res = {
            "extent": {
                "m": 2, "n": 2, "pixw": 10.0,
                "xmin": 0.0, "ymin": 0.0,
                "xmax": 20.0, "ymax": 20.0
            },
            "data_base64": base64.b64encode(np.zeros(1, dtype="<f4").tobytes()).decode(),
        }
        roost = {"lng": -3.589, "lat": 50.559, "radius_meters": 100.0}
        with tempfile.TemporaryDirectory() as work_dir:
            with self.assertRaises(ValueError):
                _write_total_resistance_raster(work_dir, total_res, roost)

    def test_source_disk_uses_radius_meters(self):
        lng, lat = -3.589, 50.559
        easting, northing = wgs84_to_bng(lng, lat)
        radius = 100.0
        pixw = 10.0
        n = m = 41
        half = n * pixw / 2.0
        extent = {
            "m": m, "n": n, "pixw": pixw,
            "xmin": easting - half, "ymin": northing - half,
            "xmax": easting + half, "ymax": northing + half,
        }
        arr = np.full((m, n), 1.0, dtype="<f4")
        total_res = {
            "extent": extent,
            "data_base64": base64.b64encode(arr.tobytes()).decode(),
        }
        roost = {"lng": lng, "lat": lat, "radius_meters": radius}
        with tempfile.TemporaryDirectory() as work_dir:
            _write_total_resistance_raster(work_dir, total_res, roost)
            src = np.loadtxt(os.path.join(work_dir, "circuitscape", "source.asc"), skiprows=6)
            self.assertEqual(src.shape, (m, n))
            self.assertEqual(src[20, 20], 1.0)
            self.assertEqual(src[20, 15], 1.0)  # 50 m from centre
            self.assertEqual(src[20, 5], 0.0)   # 150 m from centre, outside radius


class ValidDimTests(unittest.TestCase):

    def test_valid_dim_bounds(self):
        self.assertTrue(_valid_dim(1))
        self.assertTrue(_valid_dim(2000))
        self.assertFalse(_valid_dim(0))
        self.assertFalse(_valid_dim(-1))
        self.assertFalse(_valid_dim(2001))
        self.assertFalse(_valid_dim(True))
        self.assertFalse(_valid_dim("10"))
        self.assertFalse(_valid_dim(10.5))


if __name__ == "__main__":
    unittest.main()
