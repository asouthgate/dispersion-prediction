import logging
import os
import json
import subprocess
import re
import numpy as np
import rasterio
from rasterio.transform import from_bounds

logger = logging.getLogger(__name__)


def _get_db_config():
    cfg_path = os.path.expanduser("~/.bats.cfg")
    if not os.path.exists(cfg_path):
        return None
    import configparser
    cp = configparser.ConfigParser()
    cp.read(cfg_path)
    db = cp["database"]
    return {
        "host": db.get("host", "localhost"),
        "port": db.get("port", "5432"),
        "name": db.get("name", "postgres"),
        "user": db.get("user", "postgres"),
        "password": db.get("password", ""),
        "dtm_table": db.get("dtm_table", "dtm").strip("'"),
        "dsm_table": db.get("dsm_table", "dsm").strip("'"),
        "lcm_table": db.get("lcm_table", "lcm").strip("'"),
        "roads_table": db.get("roads_table", "roads").strip("'"),
        "rivers_table": db.get("rivers_table", "rivers").strip("'"),
        "buildings_table": db.get("buildings_table", "buildings").strip("'"),
    }


def _psql(cfg: dict, sql: str) -> str:
    env = os.environ.copy()
    env["PGPASSWORD"] = cfg["password"]
    cmd = [
        "psql",
        "-U", cfg["user"],
        "-d", cfg["name"],
        "-h", cfg["host"],
        "-p", cfg["port"],
        "-P", "pager=off",
        "-c", sql,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)
        if proc.returncode != 0:
            logger.error("psql failed: %s", proc.stderr[-300:])
        return proc.stdout
    except subprocess.TimeoutExpired:
        logger.error("psql timed out")
        return ""


def _fetch_raster_psql(
    cfg: dict,
    table: str,
    xmin: float, ymin: float, xmax: float, ymax: float,
    resolution: float,
):
    ncols = int((xmax - xmin) / resolution)
    nrows = int((ymax - ymin) / resolution)

    if ncols < 1 or nrows < 1:
        return None, nrows, ncols

    env_sql = (
        f"ST_SetSRID(ST_GeomFromText($$POLYGON(("
        f"{xmin} {ymax}, {xmin} {ymin}, {xmax} {ymin}, {xmax} {ymax}, {xmin} {ymax}"
        f"))$$), 27700)"
    )

    transform_sql = (
        f"ST_Resample("
        f"  ST_Clip(ST_Union(rast, 1), {env_sql}), "
        f"  {ncols}, {nrows}, {xmax}, {ymin}"
        f")"
    )

    sql = (
        f"SELECT unnest(ST_DumpValues({transform_sql}, 1)) "
        f'FROM "public"."{table}" '
        f"WHERE ST_Intersects(rast, {env_sql})"
    )

    logger.info("Fetching raster %s (%dx%d)", table, ncols, nrows)
    output = _psql(cfg, sql)
    lines = output.strip().split("\n")
    vals = []
    for line in lines:
        line = line.strip()
        if line and not line.startswith(("---", "unnest", "(", ")")):
            try:
                vals.append(float(line))
            except ValueError:
                pass

    if not vals:
        return None, nrows, ncols

    arr = np.array(vals, dtype=np.float64)
    if len(arr) != nrows * ncols:
        arr = np.array([0.0] * (nrows * ncols), dtype=np.float64)
        actual = min(len(vals), nrows * ncols)
        arr[:actual] = vals[:actual]

    return arr.reshape((nrows, ncols)), nrows, ncols


def _rasterize_vectors_psql(
    cfg: dict,
    table: str,
    nrows: int, ncols: int,
    xmin: float, ymax: float, pixw: float,
) -> np.ndarray:
    xmax = xmin + ncols * pixw
    ymin = ymax - nrows * pixw

    env_sql = (
        f"ST_MakeEnvelope({xmin}, {ymin}, {xmax}, {ymax}, 27700)"
    )

    sql = (
        f"SELECT "
        f"  ST_X(dp.geom) AS x, "
        f"  ST_Y(dp.geom) AS y "
        f'FROM "{table}", LATERAL ST_DumpPoints(geom) AS dp '
        f"WHERE ST_Intersects(geom, {env_sql})"
    )

    output = _psql(cfg, sql)
    lines = output.strip().split("\n")
    arr = np.zeros((nrows, ncols), dtype=np.float64)

    xlist = []
    ylist = []
    for line in lines:
        parts = line.strip().split("|")
        if len(parts) >= 2:
            try:
                xlist.append(float(parts[0].strip()))
                ylist.append(float(parts[1].strip()))
            except ValueError:
                pass

    for x, y in zip(xlist, ylist):
        col = int((x - xmin) / pixw)
        row = int((ymax - y) / pixw)
        if 0 <= row < nrows and 0 <= col < ncols:
            arr[row, col] = 1.0

    return arr


def write_tiff(out_path: str, arr: np.ndarray, xmin: float, ymax: float, pixw: float):
    nrows, ncols = arr.shape
    transform = from_bounds(xmin, ymax - nrows * pixw, xmin + ncols * pixw, ymax, ncols, nrows)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with rasterio.open(
        out_path,
        "w",
        driver="GTiff",
        height=nrows,
        width=ncols,
        count=1,
        dtype=np.float32,
        crs="EPSG:27700",
        transform=transform,
    ) as dst:
        dst.write(arr.astype(np.float32), 1)


def fetch_resistance_inputs(work_dir: str):
    """Fetch all required raster and vector data from PostGIS and write GeoTIFFs."""
    cfg = _get_db_config()
    if cfg is None:
        logger.warning("No ~/.bats.cfg found — skipping DB fetch")
        return

    inputs_path = os.path.join(work_dir, "inputs.json")
    with open(inputs_path) as f:
        inputs = json.load(f)

    roost = inputs["roost"]
    params = inputs.get("params", {})

    easting = roost["easting"]
    northing = roost["northing"]
    radius = roost["radius"]
    resolution = params.get("resolution", 10)

    xmin = easting - radius
    xmax = easting + radius
    ymin = northing - radius
    ymax = northing + radius

    for name in ["dtm", "dsm", "lcm"]:
        table = cfg.get(f"{name}_table", name)
        logger.info("Fetching %s raster from %s...", name, table)
        result, nrows, ncols = _fetch_raster_psql(cfg, table, xmin, ymin, xmax, ymax, resolution)
        if result is None:
            logger.warning("%s returned no data, writing zeros", name)
            result = np.zeros((nrows, ncols), dtype=np.float64)
        write_tiff(os.path.join(work_dir, f"{name}.tif"), result, xmin, ymax, resolution)

    for name, out_name in [("roads_table", "road_binary"), ("rivers_table", "river_binary"), ("buildings_table", "buildings")]:
        table = cfg.get(name)
        if not table:
            continue
        logger.info("Rasterizing %s from %s...", name, table)
        arr = _rasterize_vectors_psql(cfg, table, nrows, ncols, xmin, ymax, resolution)
        write_tiff(os.path.join(work_dir, f"{out_name}.tif"), arr, xmin, ymax, resolution)

    logger.info("Data fetch complete for %s", work_dir)
