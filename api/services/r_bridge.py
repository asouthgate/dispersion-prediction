"""R bridge: calls existing R pipeline scripts via subprocess."""

import json
import os
import subprocess
import tempfile
import shutil
import logging
from pathlib import Path
from typing import Any

from pyproj import Transformer

logger = logging.getLogger(__name__)

WGS84 = "EPSG:4326"
BNG = "EPSG:27700"

_transformer = Transformer.from_crs(WGS84, BNG, always_xy=True)


def wgs84_to_bng(lng: float, lat: float) -> tuple[float, float]:
    easting, northing = _transformer.transform(lng, lat)
    return easting, northing


def _geojson_to_geopackage(geojson: dict[str, Any], path: str, layer: str) -> None:
    """Write a GeoJSON dict to a GeoPackage file using fiona."""
    import fiona

    features = []
    geom_type = None

    if geojson.get("type") == "FeatureCollection":
        features = geojson.get("features", [])
    elif geojson.get("type") == "Feature":
        features = [geojson]
    elif geojson.get("type") in ("Polygon", "MultiPolygon", "LineString", "MultiLineString", "Point", "MultiPoint"):
        features = [{"type": "Feature", "geometry": geojson, "properties": {}}]

    if not features:
        return

    geom_type = features[0]["geometry"]["type"]
    schema = {"geometry": geom_type, "properties": {}}

    with fiona.open(path, "w", driver="GPKG", schema=schema, crs=WGS84, layer=layer) as dst:
        for feat in features:
            dst.write({"geometry": feat["geometry"], "properties": {}})


def _write_input_files(
    work_dir: str,
    roost: dict[str, Any] | None,
    features: list[dict[str, Any]],
    lamps: list[dict[str, Any]],
    params: dict[str, int | float],
) -> None:
    """Write pipeline input files to the working directory.

    Creates:
      - inputs.json: roost (BNG), params, lamps
      - drawn_buildings.gpkg / drawn_roads.gpkg / drawn_rivers.gpkg / drawn_lights.gpkg
    """
    # Convert roost to BNG
    roost_bng = None
    if roost:
        easting, northing = wgs84_to_bng(roost["lng"], roost["lat"])
        roost_bng = {
            "easting": easting,
            "northing": northing,
            "radius": roost.get("radiusMeters", roost.get("radius_meters", 2500)),
        }

    # Classify features by category
    by_category: dict[str, list[dict[str, Any]]] = {
        "Building": [],
        "Road": [],
        "River": [],
        "Lights": [],
        "LightString": [],
    }

    for f in features:
        cat = f.get("category", "")
        if cat in by_category:
            by_category[cat].append(f)
        elif cat == "Roost":
            pass  # roost handled separately

    # Write GeoPackage files per category
    for cat, feats in by_category.items():
        if not feats:
            continue
        geojson_features = []
        for f in feats:
            gj = f.get("geojson", {})
            if gj.get("type") == "Feature":
                gj = {"type": "Feature", **gj}
                # Inject height/spacing from data
                extra = f.get("data", {})
                if extra:
                    gj.setdefault("properties", {})
                    gj["properties"].update(extra)
                geojson_features.append(gj)

        if geojson_features:
            fc = {"type": "FeatureCollection", "features": geojson_features}
            gpkg_path = os.path.join(work_dir, f"drawn_{cat.lower()}.gpkg")
            _geojson_to_geopackage(fc, gpkg_path, cat.lower())

    # Write JSON input file
    input_data = {
        "roost": roost_bng,
        "params": params,
        "lamps": lamps,
    }
    with open(os.path.join(work_dir, "inputs.json"), "w") as f:
        json.dump(input_data, f, indent=2)


def run_pipeline(
    stage: str,
    roost: dict[str, Any] | None,
    features: list[dict[str, Any]],
    lamps: list[dict[str, Any]],
    params: dict[str, int | float],
    work_dir: str,
) -> subprocess.Popen:
    """Launch the appropriate R pipeline script as a subprocess.

    Returns the Popen handle for monitoring.
    """
    _write_input_files(work_dir, roost, features, lamps, params)

    r_script_map = {
        "coverage": "scripts/run_coverage_pipeline.R",
        "resistance": "scripts/run_resistance_pipeline.R",
        "current": "scripts/run_circuitscape.R",
    }

    rscript = r_script_map.get(stage)
    if not rscript:
        raise ValueError(f"Unknown stage: {stage}")

    rscript_path = os.path.join(work_dir, "..", "..", rscript)

    env = os.environ.copy()
    env["R_PIPELINE_WORKDIR"] = work_dir
    env["R_PIPELINE_INPUT"] = os.path.join(work_dir, "inputs.json")

    proc = subprocess.Popen(
        ["Rscript", rscript_path, os.path.join(work_dir, "inputs.json")],
        cwd=work_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    return proc


def collect_results(work_dir: str) -> list[dict[str, Any]]:
    """Collect result rasters from the working directory.

    Returns a list of layer dicts with id, path, and bounds.
    """
    layers = []

    # Expected raster outputs from the R pipeline
    expected_layers = [
        ("log_total_res", "Log Total Resistance"),
        ("total_res", "Total Resistance"),
        ("road_res", "Road Resistance"),
        ("river_res", "River Resistance"),
        ("landscape_res", "Landscape Resistance"),
        ("linear_res", "Linear Resistance"),
        ("lamp_res", "Lamp Resistance"),
        ("log_lamp_res", "Log Lamp Resistance"),
        ("dsm", "DSM"),
        ("dtm", "DTM"),
        ("log_current", "Log Current"),
    ]

    for file_key, display_name in expected_layers:
        tif_path = os.path.join(work_dir, f"{file_key}.tif")
        if os.path.exists(tif_path):
            layers.append({
                "id": file_key,
                "name": display_name,
                "tif_path": tif_path,
            })

    return layers
