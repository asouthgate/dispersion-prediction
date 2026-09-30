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
                _write_total_resistance_raster(work_dir, total_res, roost, 50)

    def _write_and_load(self, work_dir, total_res, roost, n_circles):
        _write_total_resistance_raster(work_dir, total_res, roost, n_circles)
        source = np.loadtxt(os.path.join(work_dir, "circuitscape", "source.asc"), skiprows=6)
        ground = np.loadtxt(os.path.join(work_dir, "circuitscape", "ground.asc"), skiprows=6)
        return source, ground

    def _total_res(self, easting, northing, radius=100.0, pixw=10.0, n=41, m=41):
        half = n * pixw / 2.0
        extent = {
            "m": m, "n": n, "pixw": pixw,
            "xmin": easting - half, "ymin": northing - half,
            "xmax": easting + half, "ymax": northing + half,
        }
        arr = np.full((m, n), 1.0, dtype="<f4")
        return {
            "extent": extent,
            "data_base64": base64.b64encode(arr.tobytes()).decode(),
        }

    def test_source_is_rings_not_roost(self):
        lng, lat = -3.589, 50.559
        easting, northing = wgs84_to_bng(lng, lat)
        radius = 100.0
        total_res = self._total_res(easting, northing, radius)
        roost = {"lng": lng, "lat": lat, "radius_meters": radius}
        with tempfile.TemporaryDirectory() as work_dir:
            source, _ = self._write_and_load(work_dir, total_res, roost, n_circles=1)
            self.assertEqual(source.shape, (41, 41))
            self.assertEqual(source[20, 20], -9999.0)  # centre is not a source
            self.assertEqual(source[30, 20], 1.0)  # outer ring (100 m = 10 cells) is a source
            self.assertEqual(source[20, 5], -9999.0)  # 150 m out, outside radius

    def test_ground_is_roost_not_rings(self):
        lng, lat = -3.589, 50.559
        easting, northing = wgs84_to_bng(lng, lat)
        radius = 100.0
        total_res = self._total_res(easting, northing, radius)
        roost = {"lng": lng, "lat": lat, "radius_meters": radius}
        with tempfile.TemporaryDirectory() as work_dir:
            _, ground = self._write_and_load(work_dir, total_res, roost, n_circles=1)
            self.assertEqual(ground[20, 20], 1.0)  # roost is the ground
            self.assertEqual(ground[20, 21], -9999.0)  # neighbours are NODATA
            self.assertEqual(int(ground[ground == 1.0].size), 1)  # single ground cell

    def test_source_respects_radius_boundary(self):
        lng, lat = -3.589, 50.559
        easting, northing = wgs84_to_bng(lng, lat)
        radius = 100.0
        total_res = self._total_res(easting, northing, radius)
        roost = {"lng": lng, "lat": lat, "radius_meters": radius}
        with tempfile.TemporaryDirectory() as work_dir:
            source, _ = self._write_and_load(work_dir, total_res, roost, n_circles=5)
            self.assertEqual(source[20, 20], -9999.0)  # centre remains empty
            self.assertEqual(source[20, 5], -9999.0)  # 150 m out, outside radius

    def test_more_circles_yield_more_source_cells(self):
        lng, lat = -3.589, 50.559
        easting, northing = wgs84_to_bng(lng, lat)
        radius = 100.0
        total_res = self._total_res(easting, northing, radius)
        roost = {"lng": lng, "lat": lat, "radius_meters": radius}
        counts = {}
        with tempfile.TemporaryDirectory() as work_dir:
            for n_circles in (1, 5):
                source, _ = self._write_and_load(work_dir, total_res, roost, n_circles=n_circles)
                counts[n_circles] = int((source == 1.0).sum())
        self.assertGreater(counts[5], counts[1])


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
