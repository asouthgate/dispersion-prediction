"""Regression tests for known bugs."""

import os
import sys
import unittest
import json
import tempfile
import shutil

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class GpkgFloatFieldRegression(unittest.TestCase):
    """Regression test for the fiona 'Skipping field because of invalid value' bug.

    When a Light feature has height=10 (integer from JSON), fiona's float schema
    rejects it. The fix converts all float-schema fields to actual floats before
    writing to the GPKG.
    """

    def setUp(self):
        self.work_dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.work_dir, ignore_errors=True)

    def test_integer_height_written_to_gpkg(self):
        """Integer height values from the frontend must be accepted by fiona."""
        from api.services.r_bridge import _write_input_files

        features = [
            {
                "id": "light-1",
                "category": "Lights",
                "label": "Test Light",
                "geometryKind": "point",
                "geojson": {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [-3.59, 50.59]},
                    "properties": {},
                },
                "data": {"height": 10},  # integer, not float
            },
        ]

        _write_input_files(self.work_dir, None, features, {})

        gpkg_path = os.path.join(self.work_dir, "drawn_lights.gpkg")
        self.assertTrue(os.path.exists(gpkg_path), "drawn_lights.gpkg should exist")

        # Verify the GPKG can be read back and has the height property
        import fiona
        with fiona.open(gpkg_path, "r") as src:
            self.assertEqual(len(src), 1)
            feat = next(iter(src))
            self.assertEqual(feat["properties"]["height"], 10.0)

    def test_float_height_written_to_gpkg(self):
        """Float height values should also work."""
        from api.services.r_bridge import _write_input_files

        features = [
            {
                "id": "light-1",
                "category": "Lights",
                "label": "Test Light",
                "geometryKind": "point",
                "geojson": {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [-3.59, 50.59]},
                    "properties": {},
                },
                "data": {"height": 13.75},
            },
        ]

        _write_input_files(self.work_dir, None, features, {})

        gpkg_path = os.path.join(self.work_dir, "drawn_lights.gpkg")
        self.assertTrue(os.path.exists(gpkg_path))

        import fiona
        with fiona.open(gpkg_path, "r") as src:
            feat = next(iter(src))
            self.assertAlmostEqual(feat["properties"]["height"], 13.75)

    def test_lightstring_spacing_and_height_written_to_gpkg(self):
        """LightString features with integer spacing and height should work."""
        from api.services.r_bridge import _write_input_files

        features = [
            {
                "id": "lightstring-1",
                "category": "LightString",
                "label": "Test LightString",
                "geometryKind": "linestring",
                "geojson": {
                    "type": "Feature",
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[-3.59, 50.59], [-3.58, 50.60]],
                    },
                    "properties": {},
                },
                "data": {"height": 5, "spacing": 50},  # both integers
            },
        ]

        _write_input_files(self.work_dir, None, features, {})

        gpkg_path = os.path.join(self.work_dir, "drawn_lightstring.gpkg")
        self.assertTrue(os.path.exists(gpkg_path))

        import fiona
        with fiona.open(gpkg_path, "r") as src:
            feat = next(iter(src))
            self.assertAlmostEqual(feat["properties"]["height"], 5.0)
            self.assertAlmostEqual(feat["properties"]["spacing"], 50.0)

    def test_building_height_written_to_gpkg(self):
        """Building features with integer height should work."""
        from api.services.r_bridge import _write_input_files

        features = [
            {
                "id": "building-1",
                "category": "Building",
                "label": "Test Building",
                "geometryKind": "polygon",
                "geojson": {
                    "type": "Feature",
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[
                            [-3.59, 50.59], [-3.58, 50.59],
                            [-3.58, 50.60], [-3.59, 50.60],
                            [-3.59, 50.59],
                        ]],
                    },
                    "properties": {},
                },
                "data": {"height": 15},
            },
        ]

        _write_input_files(self.work_dir, None, features, {})

        gpkg_path = os.path.join(self.work_dir, "drawn_building.gpkg")
        self.assertTrue(os.path.exists(gpkg_path))

        import fiona
        with fiona.open(gpkg_path, "r") as src:
            feat = next(iter(src))
            self.assertAlmostEqual(feat["properties"]["height"], 15.0)


class UnifiedFeaturesRegression(unittest.TestCase):
    """Regression test: features and lamps are unified, no separate lamps field."""

    def test_pipeline_request_no_lamps_field(self):
        """PipelineRequest should not have a lamps field."""
        from schemas.pipeline import PipelineRequest
        fields = PipelineRequest.model_fields
        self.assertIn("features", fields)
        self.assertNotIn("lamps", fields, "lamps field should not exist in PipelineRequest")

    def test_payload_hash_no_lamps(self):
        """_payload_hash should not accept a lamps parameter."""
        from tasks import _payload_hash
        import inspect
        sig = inspect.signature(_payload_hash)
        params = list(sig.parameters.keys())
        self.assertIn("stage", params)
        self.assertIn("features", params)
        self.assertNotIn("lamps", params, "lamps parameter should not exist in _payload_hash")


if __name__ == "__main__":
    unittest.main()
