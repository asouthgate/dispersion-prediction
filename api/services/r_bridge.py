"""R bridge: calls existing R pipeline scripts via subprocess."""

import copy
import fiona
import json
import os
import subprocess
import logging
from typing import Any

from pyproj import Transformer

logger = logging.getLogger(__name__)

WGS84 = "EPSG:4326"
BNG = "EPSG:27700"

_default_transformer = Transformer.from_crs(WGS84, BNG, always_xy=True)


def wgs84_to_bng(lng: float, lat: float) -> tuple[float, float]:
    easting, northing = _default_transformer.transform(lng, lat)
    return easting, northing


def _transform_coords_wgs84_to_bng(obj: Any, transformer: Transformer = _default_transformer) -> Any:
    """Recursively transform all [lng, lat] coordinate pairs"""
    if isinstance(obj, list):
        if (len(obj) == 2
                and isinstance(obj[0], (int, float))
                and isinstance(obj[1], (int, float))
                and -180 <= float(obj[0]) <= 180
                and -90 <= float(obj[1]) <= 90):
            # Safe because the transformer is guaranteed to have always_xy=True
            easting, northing = transformer.transform(float(obj[0]), float(obj[1]))
            return [easting, northing]
        return [_transform_coords_wgs84_to_bng(item, transformer) for item in obj]
    if isinstance(obj, dict):
        return {k: _transform_coords_wgs84_to_bng(v, transformer) for k, v in obj.items()}
    return obj


_CATEGORY_PROPERTY_FIELDS: dict[str, dict[str, str]] = {
    "Building": {"height": "float"},
    "Road": {},
    "River": {},
    "Lights": {"height": "float"},
    "LightSequence": {"height": "float", "spacing": "float"},
    "GenericResistance": {"resistanceValue": "float"},
}

_BROWSER_SIDE_CATEGORIES = {"Lights", "LightSequence"}


def _geojson_to_geopackage(geojson: dict[str, Any], path: str, layer: str,
                           prop_schema: dict[str, str] | None = None) -> None:
    """Write a GeoJSON dict to a GeoPackage file using fiona, with geometry
    already in BNG.  Set the output CRS to EPSG:27700."""

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
    if prop_schema is None:
        prop_schema = {}
    schema: dict[str, Any] = {"geometry": geom_type, "properties": prop_schema}

    with fiona.open(path, "w", driver="GPKG", schema=schema, crs=BNG, layer=layer) as dst:
        for feat in features:
            props = feat.get("properties", {})
            write_props = {}
            for k in prop_schema:
                val = props.get(k)
                if val is not None:
                    write_props[k] = float(val) if prop_schema[k] == "float" else val
                else:
                    write_props[k] = 0.0 if prop_schema[k] == "float" else None
            dst.write({"geometry": feat["geometry"], "properties": write_props})



def _write_input_files(
    work_dir: str,
    roost: dict[str, Any] | None,
    features: list[dict[str, Any]],
    params: dict[str, int | float],
) -> None:
    """Write pipeline input files to the working directory.

    Creates:
      - inputs.json: roost (BNG), params
      - drawn_building.gpkg / drawn_road.gpkg / drawn_river.gpkg /
        drawn_lights.gpkg / drawn_lightsequence.gpkg /
        drawn_genericresistance.gpkg  (all in BNG)
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

    # Classify features by category (skip browser-side categories)
    by_category: dict[str, list[dict[str, Any]]] = {
        "Building": [],
        "Road": [],
        "River": [],
        "GenericResistance": [],
    }

    lamp_count = 0
    for f in features:
        cat = f.get("category", "")
        if cat in _BROWSER_SIDE_CATEGORIES:
            lamp_count += 1
        elif cat in by_category:
            by_category[cat].append(f)
        elif cat == "Roost":
            pass  # roost handled separately

    if lamp_count > 0:
        logger.info("Skipped %d lamp feature(s): delegating to browser-side", lamp_count)

    # Write GeoPackage files per category (geometries transformed to BNG)
    for cat, feats in by_category.items():
        if not feats:
            continue
        geojson_features = []
        prop_schema = _CATEGORY_PROPERTY_FIELDS.get(cat, {})
        for f in feats:
            gj = f.get("geojson", {})
            if gj.get("type") == "Feature":
                gj = copy.deepcopy(gj)
            elif gj.get("type") in ("Point", "LineString", "Polygon",
                                    "MultiPoint", "MultiLineString", "MultiPolygon"):
                gj = {"type": "Feature", "geometry": copy.deepcopy(gj), "properties": {}}
            else:
                continue
            extra = f.get("data", {})
            if extra:
                gj.setdefault("properties", {})
                gj["properties"].update(extra)
            gj["geometry"] = _transform_coords_wgs84_to_bng(gj["geometry"])
            geojson_features.append(gj)

        if geojson_features:
            fc = {"type": "FeatureCollection", "features": geojson_features}
            gpkg_path = os.path.join(work_dir, f"drawn_{cat.lower()}.gpkg")
            _geojson_to_geopackage(fc, gpkg_path, cat.lower(),
                                   prop_schema=prop_schema)

    # Write JSON input file
    input_data = {
        "roost": roost_bng,
        "params": params,
    }
    with open(os.path.join(work_dir, "inputs.json"), "w") as f:
        json.dump(input_data, f, indent=2)


def run_pipeline(
    stage: str,
    roost: dict[str, Any] | None,
    features: list[dict[str, Any]],
    params: dict[str, int | float],
    work_dir: str,
) -> subprocess.CompletedProcess:
    """Launch the appropriate R pipeline script as a subprocess.

    Returns the Popen handle for monitoring.
    """
    _write_input_files(work_dir, roost, features, params)

    r_script_map = {
        "coverage": "scripts/run-coverage-pipeline.R",
        "resistance": "scripts/run-resistance-pipeline-json.R",
        "current": "scripts/run-circuitscape.R",
    }

    rscript = r_script_map.get(stage)
    if not rscript:
        raise ValueError(f"Unknown stage: {stage}")

    rscript_path = os.path.join(work_dir, "..", "..", rscript)

    env = os.environ.copy()
    env["R_PIPELINE_WORKDIR"] = work_dir
    env["R_PIPELINE_INPUT"] = os.path.join(work_dir, "inputs.json")

    result = subprocess.run(
        ["Rscript", rscript_path, os.path.join(work_dir, "inputs.json")],
        cwd=work_dir,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    if result.stdout:
        logger.info(f"R Pipeline Output:\n{result.stdout}")
    if result.stderr:
        logger.error(f"R Pipeline Error Output:\n{result.stderr}")

    if result.returncode != 0:
        raise RuntimeError(f"R script failed with exit code {result.returncode}")

    return result

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
        ("dsm", "Digital Surface Model"),
        ("dtm", "Digital Terrain Model"),
        ("lcm", "Land Cover Map"),
        ("soft_surf", "Soft Surface"),
        ("hard_surf", "Hard Surface"),
        ("generic_res", "Generic Resistance"),
        ("log_current", "Log Current"),
    ]

    found_ids = []
    for file_key, display_name in expected_layers:
        tif_path = os.path.join(work_dir, f"{file_key}.tif")
        if os.path.exists(tif_path):
            layers.append({
                "id": file_key,
                "name": display_name,
                "tif_path": tif_path,
            })
            found_ids.append(file_key)

    # Log which coverage layers were found: useful for diagnosing missing LCM
    coverage_expected = {"dtm", "dsm", "lcm"}
    coverage_found = set(found_ids) & coverage_expected
    if coverage_found != coverage_expected:
        missing = coverage_expected - coverage_found
        logger.warning("Coverage layers missing from work dir: %s (found: %s)", missing, coverage_found)
    else:
        logger.info("All coverage layers present: %s", coverage_found)

    return layers

def collect_raster_info(work_dir: str) -> dict | None:
    """Read raster extent metadata from the first GeoTIFF in the work dir."""
    try:
        for fname in os.listdir(work_dir):
            if fname.endswith('.tif'):
                path = os.path.join(work_dir, fname)
                import rasterio
                with rasterio.open(path) as src:
                    return {
                        "m": src.height,
                        "n": src.width,
                        "pixw": abs(src.transform.a),
                        "xmin": src.bounds.left,
                        "ymin": src.bounds.bottom,
                        "xmax": src.bounds.right,
                        "ymax": src.bounds.top,
                    }
    except (FileNotFoundError, OSError):
        pass
    return None
