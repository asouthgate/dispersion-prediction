"""Tests for total_resistance validation (dimension cap + byte-length guard)."""

import base64
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class TotalResistanceTests(unittest.TestCase):

    def test_size_mismatch_raises(self):
        import numpy as np
        from tasks import _write_total_resistance_raster

        total_res = {
            "extent": {"m": 2, "n": 2, "pixw": 10.0,
                       "xmin": 0.0, "ymin": 0.0, "xmax": 20.0, "ymax": 20.0},
            "data_base64": base64.b64encode(np.zeros(1, dtype="<f4").tobytes()).decode(),
        }
        roost = {"lng": -3.589, "lat": 50.559, "radiusMeters": 100.0}
        with tempfile.TemporaryDirectory() as work_dir:
            with self.assertRaises(ValueError):
                _write_total_resistance_raster(work_dir, total_res, roost)


class ValidDimTests(unittest.TestCase):

    def test_valid_dim_bounds(self):
        from routers.pipeline import _valid_dim
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
