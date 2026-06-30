"""Unit tests for r_bridge.py coordinate conversion and input file writing."""

import json
import os
import tempfile
import pytest
from pyproj import Transformer

import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from api.services.r_bridge import (
    wgs84_to_bng,
    _transform_coords_wgs84_to_bng,
    _write_input_files,
)


def test_wgs84_to_bng_transforms_correctly():
    easting, northing = wgs84_to_bng(-3.590523, 50.586362)
    assert 287000 < easting < 287800, f"easting={easting} out of expected range"
    assert 77000 < northing < 78000, f"northing={northing} out of expected range"


def test_transform_point_geometry():
    geom = {"type": "Point", "coordinates": [-3.590523, 50.586362]}
    result = _transform_coords_wgs84_to_bng(geom)
    coords = result["coordinates"]
    assert 287000 < coords[0] < 287800, f"converted x={coords[0]} out of range"
    assert 77000 < coords[1] < 78000, f"converted y={coords[1]} out of range"


def test_transform_linestring_geometry():
    geom = {
        "type": "LineString",
        "coordinates": [
            [-3.5900, 50.5863],
            [-3.5905, 50.5867],
        ],
    }
    result = _transform_coords_wgs84_to_bng(geom)
    assert result["type"] == "LineString"
    for coord in result["coordinates"]:
        assert 287000 < coord[0] < 287800
        assert 77000 < coord[1] < 78000


def test_transform_polygon_geometry():
    geom = {
        "type": "Polygon",
        "coordinates": [
            [
                [-3.5910, 50.5860],
                [-3.5900, 50.5860],
                [-3.5900, 50.5870],
                [-3.5910, 50.5870],
                [-3.5910, 50.5860],
            ]
        ],
    }
    result = _transform_coords_wgs84_to_bng(geom)
    assert result["type"] == "Polygon"
    for ring in result["coordinates"]:
        for coord in ring:
            assert 287000 < coord[0] < 287800
            assert 77000 < coord[1] < 78000


def test_transform_does_not_mutate_original():
    geom = {"type": "Point", "coordinates": [-3.590523, 50.586362]}
    _transform_coords_wgs84_to_bng(geom)
    assert geom["coordinates"][0] == -3.590523
    assert geom["coordinates"][1] == 50.586362


def test_transform_ignores_non_coordinate_numbers():
    obj = {"count": 42, "ratio": 0.5}
    result = _transform_coords_wgs84_to_bng(obj)
    assert result == obj


class TestWriteInputFiles:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()

    def teardown_method(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_writes_inputs_json_with_lamps_converted_to_bng(self):
        roost = {"lng": -3.590523, "lat": 50.586362, "radiusMeters": 500}
        lamps = [
            {"x": -3.5888, "y": 50.5858, "z": 13.75},
        ]
        _write_input_files(self.tmpdir, roost, [], lamps, {"resolution": 10})

        json_path = os.path.join(self.tmpdir, "inputs.json")
        assert os.path.exists(json_path)

        with open(json_path) as f:
            data = json.load(f)

        assert data["roost"] is not None
        assert 287000 < data["roost"]["easting"] < 287800
        assert 77000 < data["roost"]["northing"] < 78000
        assert data["roost"]["radius"] == 500

        assert len(data["lamps"]) == 1
        lamp = data["lamps"][0]
        assert 287000 < lamp["x"] < 287800, f"lamp x={lamp['x']} not in BNG range"
        assert 77000 < lamp["y"] < 78000, f"lamp y={lamp['y']} not in BNG range"
        assert lamp["z"] == 13.75

    def test_writes_geopackage_with_bng_geometries(self):
        import fiona

        roost = {"lng": -3.590523, "lat": 50.586362, "radiusMeters": 500}
        features = [
            {
                "id": "f1",
                "category": "Road",
                "label": "Test Road",
                "geometryKind": "linestring",
                "geojson": {
                    "type": "Feature",
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [
                            [-3.5900, 50.5863],
                            [-3.5905, 50.5867],
                        ],
                    },
                    "properties": {},
                },
            },
        ]
        _write_input_files(self.tmpdir, roost, features, [], {"resolution": 10})

        gpkg_path = os.path.join(self.tmpdir, "drawn_road.gpkg")
        assert os.path.exists(gpkg_path)

        with fiona.open(gpkg_path) as src:
            assert src.crs.to_epsg() == 27700
            feats = list(src)
            assert len(feats) == 1
            coords = feats[0]["geometry"]["coordinates"]
            assert 287000 < coords[0][0] < 287800, f"first x={coords[0][0]} not in BNG"
            assert 77000 < coords[0][1] < 78000, f"first y={coords[0][1]} not in BNG"

    def test_empty_lamps_produces_empty_array(self):
        roost = {"lng": -3.590523, "lat": 50.586362, "radiusMeters": 500}
        _write_input_files(self.tmpdir, roost, [], [], {})

        json_path = os.path.join(self.tmpdir, "inputs.json")
        with open(json_path) as f:
            data = json.load(f)
        assert data["lamps"] == []

    def test_property_fields_written_to_geopackage(self):
        import fiona

        roost = {"lng": -3.590523, "lat": 50.586362, "radiusMeters": 500}
        features = [
            {
                "id": "l1",
                "category": "Lights",
                "label": "L1",
                "geometryKind": "point",
                "geojson": {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [-3.5905, 50.5864],
                    },
                    "properties": {},
                },
                "data": {"height": 12.5},
            },
        ]
        _write_input_files(self.tmpdir, roost, features, [], {"resolution": 10})

        gpkg_path = os.path.join(self.tmpdir, "drawn_lights.gpkg")
        assert os.path.exists(gpkg_path)

        with fiona.open(gpkg_path) as src:
            feats = list(src)
            assert len(feats) == 1
            assert "height" in feats[0]["properties"]
            assert feats[0]["properties"]["height"] == 12.5
