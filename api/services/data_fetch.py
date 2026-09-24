"""Fetch rasters and vectors from PostGIS for the resistance pipeline.

Writes GeoTIFFs (rasters) and GeoJSON files (vectors) into the work directory
for the wasm-connectivity resistance-pipeline binary to consume.
"""

import json
import logging
import os

import fiona
import numpy as np
import psycopg2
import psycopg2.sql as pgsql
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject

logger = logging.getLogger(__name__)

DEFAULT_DB_NAME = "bats"
CRS_BNG = "EPSG:27700"
NODATA = -9999.0


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
        "name": db.get("name", DEFAULT_DB_NAME),
        "user": db.get("user", "postgres"),
        "password": db.get("password", ""),
        "dtm_table": db.get("dtm_table", "dtm").strip("'"),
        "dsm_table": db.get("dsm_table", "dsm").strip("'"),
        "lcm_table": db.get("lcm_table", "lcm").strip("'"),
        "roads_table": db.get("roads_table", "roads").strip("'"),
        "rivers_table": db.get("rivers_table", "rivers").strip("'"),
        "buildings_table": db.get("buildings_table", "buildings").strip("'"),
    }


def _connect(cfg):
    return psycopg2.connect(
        host=cfg["host"],
        port=cfg["port"],
        dbname=cfg["name"],
        user=cfg["user"],
        password=cfg["password"],
    )


def query_raster_values(conn, table, xmin, ymin, xmax, ymax, ncols, nrows):
    """Clip+resample a raster table to the requested extent and return its values.

    Returns ``(values, envelope)`` where ``values`` is a float32 array of shape
    ``(nrows, ncols)`` and ``envelope`` is the actual ``[xmin, ymin, xmax, ymax]``
    covered by the returned raster. The envelope can be *smaller* (and
    non-square) than the requested extent when the data does not fully cover it.

    Returns ``None`` when there is no data.
    """
    cur = conn.cursor()
    try:
        cur.execute(
            pgsql.SQL(
                """
                WITH resampled AS (
                    SELECT ST_Resample(
                        ST_Union(ST_Clip(rast, geom)),
                        %s, %s
                    ) AS rast
                    FROM {},
                         (SELECT ST_MakeEnvelope(%s, %s, %s, %s, 27700) AS geom) AS t2
                    WHERE tile_extent && t2.geom
                )
                SELECT
                    ST_DumpValues(rast, 1),
                    ST_XMin(ST_Envelope(rast)),
                    ST_YMin(ST_Envelope(rast)),
                    ST_XMax(ST_Envelope(rast)),
                    ST_YMax(ST_Envelope(rast))
                FROM resampled
                """
            ).format(pgsql.Identifier(table)),
            (ncols, nrows, xmin, ymin, xmax, ymax),
        )
        row = cur.fetchone()
        if row is None or row[0] is None:
            return None

        vals, rxmin, rymin, rxmax, rymax = row
        if isinstance(vals, str):
            vals = json.loads(vals.replace("{", "[").replace("}", "]"))

        arr = np.array(vals, dtype=np.float32)
        if arr.shape != (nrows, ncols):
            logger.warning(
                "ST_DumpValues returned shape %s, expected (%d, %d)",
                arr.shape, nrows, ncols,
            )
            return None

        envelope = (float(rxmin), float(rymin), float(rxmax), float(rymax))
        return arr, envelope
    finally:
        cur.close()


def query_vector_geojson(conn, table, layer_name, xmin, ymin, xmax, ymax):
    """Return a GeoJSON FeatureCollection string for a vector table within the extent.

    Returns ``None`` when there are no features.
    """
    cur = conn.cursor()
    try:
        cur.execute(
            pgsql.SQL(
                """
                SELECT jsonb_build_object(
                    'type', 'FeatureCollection',
                    'features', jsonb_agg(jsonb_build_object(
                        'type', 'Feature',
                        'geometry', ST_AsGeoJSON(geom)::jsonb,
                        'properties', jsonb_build_object('layer', %s)
                    ))
                )
                FROM {}
                WHERE ST_Intersects(geom, ST_MakeEnvelope(%s, %s, %s, %s, 27700))
                """
            ).format(pgsql.Identifier(table)),
            (layer_name, xmin, ymin, xmax, ymax),
        )
        row = cur.fetchone()
        if row is None or row[0] is None:
            return None
        return row[0] if isinstance(row[0], str) else json.dumps(row[0])
    finally:
        cur.close()



def target_square_grid(xmin, ymin, xmax, ymax, resolution):
    """Build a square raster grid anchored on the requested extent.

    Returns ``(ncols, nrows, transform)``. Because the extent is square
    (``xmax - xmin == ymax - ymin``) and ``ncols == nrows``, the pixels are
    square (``transform.a == -transform.e``).
    """
    ncols = int((xmax - xmin) / resolution)
    nrows = int((ymax - ymin) / resolution)
    transform = from_bounds(xmin, ymin, xmax, ymax, ncols, nrows)
    return ncols, nrows, transform


def resample_to_grid(values, src_transform, dst_transform, dst_width, dst_height, nodata=NODATA):
    """Reproject ``values`` from ``src_transform`` onto a target grid.

    ``values`` is a 2D float array on the source grid (in EPSG:27700). Cells of
    the target grid that fall outside the source footprint are filled with
    ``nodata``.
    """
    dst = np.full((dst_height, dst_width), nodata, dtype=np.float32)
    reproject(
        source=values.astype(np.float32),
        destination=dst,
        src_transform=src_transform,
        src_crs=CRS.from_string(CRS_BNG),
        dst_transform=dst_transform,
        dst_crs=CRS.from_string(CRS_BNG),
        resampling=Resampling.bilinear,
        src_nodata=nodata,
        dst_nodata=nodata,
    )
    return dst


def write_raster_tif(path, values, transform, crs=CRS_BNG, nodata=NODATA):
    """Write a single-band float32 GeoTIFF."""
    height, width = values.shape
    with rasterio.open(
        path, "w", driver="GTiff", height=height, width=width,
        count=1, dtype="float32", crs=crs, transform=transform,
        nodata=nodata, compress="deflate",
    ) as dst:
        dst.write(values.astype(np.float32), 1)


def _write_tiff_sidecar(work_dir, transform, nrows, ncols):
    info = {
        "xmin": transform.c,
        "ymax": transform.f,
        "pixw": abs(transform.a),
        "nrows": nrows,
        "ncols": ncols,
    }
    with open(os.path.join(work_dir, "grid_info.json"), "w") as f:
        json.dump(info, f)




def fetch_raster_stack(conn, work_dir, rasters, extent, resolution):
    """Fetch ``rasters`` (list of ``(name, table)``) onto a common square grid.

    Each raster is resampled to the square grid anchored on the requested
    extent (padding missing coverage with nodata), so all rasters share a single
    aligned grid. Writes ``work_dir/{name}.tif``.

    Returns ``(transform, ncols, nrows)`` of the square grid.
    """
    xmin, ymin, xmax, ymax = extent
    ncols, nrows, transform = target_square_grid(xmin, ymin, xmax, ymax, resolution)

    for name, table in rasters:
        out_path = os.path.join(work_dir, f"{name}.tif")
        logger.info("Fetching %s raster from %s...", name, table)

        fetched = query_raster_values(conn, table, xmin, ymin, xmax, ymax, ncols, nrows)
        if fetched is None:
            logger.warning("%s returned no data, writing zeros", name)
            write_raster_tif(out_path, np.zeros((nrows, ncols), dtype=np.float32), transform)
            continue

        values, envelope = fetched
        rxmin, rymin, rxmax, rymax = envelope
        src_transform = from_bounds(rxmin, rymin, rxmax, rymax, ncols, nrows)
        if src_transform != transform:
            values = resample_to_grid(values, src_transform, transform, ncols, nrows)

        write_raster_tif(out_path, values, transform)
        logger.info("Wrote %s.tif (%dx%d) on square grid", name, ncols, nrows)

    return transform, ncols, nrows


def fetch_vector_stack(conn, work_dir, vectors, extent):
    """Fetch ``vectors`` (list of ``(name, table)``) as GeoJSON and merge drawn features.

    A ``table`` of ``None`` means there is no DB source; an empty
    FeatureCollection is written instead. User-drawn features (from GPKG files)
    are merged on top afterwards.
    """
    xmin, ymin, xmax, ymax = extent

    for name, table in vectors:
        path = os.path.join(work_dir, f"{name}.geojson")
        if table:
            logger.info("Fetching %s vectors from %s...", name, table)
            gj = query_vector_geojson(conn, table, name, xmin, ymin, xmax, ymax)
        else:
            gj = None

        if gj is None:
            if table:
                logger.warning("No %s vectors found", name)
            gj = json.dumps({"type": "FeatureCollection", "features": []})

        with open(path, "w") as f:
            f.write(gj)
        logger.info("Wrote %s.geojson (%d bytes)", name, len(gj))

    _merge_drawn_features(work_dir)


def _merge_drawn_features(work_dir):
    gpkg_map = {
        "drawn_building.gpkg": "buildings.geojson",
        "drawn_road.gpkg": "roads.geojson",
        "drawn_river.gpkg": "rivers.geojson",
        "drawn_genericresistance.gpkg": "generic_resistance.geojson",
    }

    for gpkg_name, geojson_name in gpkg_map.items():
        gpkg_path = os.path.join(work_dir, gpkg_name)
        if not os.path.exists(gpkg_path):
            continue

        layer = geojson_name.replace(".geojson", "")
        try:
            with fiona.open(gpkg_path, "r") as src:
                features = []
                for feat in src:
                    props = dict(feat.get("properties", {}))
                    props["layer"] = layer
                    features.append(
                        {
                            "type": "Feature",
                            "geometry": feat.__geo_interface__["geometry"],
                            "properties": props,
                        }
                    )
        except Exception as e:
            logger.warning("Failed to read %s: %s", gpkg_name, e)
            continue

        if not features:
            continue

        geojson_path = os.path.join(work_dir, geojson_name)
        existing = {"type": "FeatureCollection", "features": []}
        if os.path.exists(geojson_path):
            try:
                with open(geojson_path) as f:
                    existing = json.load(f)
            except (json.JSONDecodeError, OSError):
                pass

        existing["features"].extend(features)
        with open(geojson_path, "w") as f:
            json.dump(existing, f)

        logger.info(
            "Merged %d drawn %s features into %s",
            len(features),
            gpkg_name,
            geojson_name,
        )


def _read_inputs(work_dir):
    with open(os.path.join(work_dir, "inputs.json")) as f:
        return json.load(f)


def _extent_from_inputs(inputs):
    """Return ``(extent, resolution, easting, northing, radius)`` from inputs.json."""
    roost = inputs["roost"]
    params = inputs.get("params", {})

    easting = roost["easting"]
    northing = roost["northing"]
    radius = roost["radius"]
    resolution = params.get("resolution", 10)

    extent = (easting - radius, northing - radius, easting + radius, northing + radius)
    return extent, resolution, easting, northing, radius


def fetch_coverage_inputs(work_dir: str):
    """Fetch DTM/DSM rasters from PostGIS for the coverage stage."""
    cfg = _get_db_config()
    if cfg is None:
        logger.warning("No ~/.bats.cfg found — skipping DB fetch")
        return

    inputs = _read_inputs(work_dir)
    extent, resolution, easting, northing, radius = _extent_from_inputs(inputs)
    xmin, ymin, xmax, ymax = extent
    ncols, nrows, _ = target_square_grid(xmin, ymin, xmax, ymax, resolution)

    logger.info(
        "Coverage fetch: extent=[%.2f,%.2f,%.2f,%.2f] %dx%d, roost=[%.2f,%.2f], radius=%.0f",
        xmin, ymin, xmax, ymax, ncols, nrows, easting, northing, radius,
    )

    rasters = [
        ("dtm", cfg.get("dtm_table", "dtm")),
        ("dsm", cfg.get("dsm_table", "dsm")),
    ]

    conn = _connect(cfg)
    try:
        fetch_raster_stack(conn, work_dir, rasters, extent, resolution)
    finally:
        conn.close()

    logger.info("Coverage data fetch complete for %s", work_dir)


def fetch_landscape_inputs(work_dir: str):
    """Fetch DTM/DSM/LCM rasters and building/road/river vectors for landscape computation.

    Rasters are resampled onto a common square grid; vectors are written as
    GeoJSON with user-drawn features merged on top.
    """
    cfg = _get_db_config()
    if cfg is None:
        logger.warning("No ~/.bats.cfg found — skipping DB fetch")
        return

    inputs = _read_inputs(work_dir)
    extent, resolution, easting, northing, radius = _extent_from_inputs(inputs)
    xmin, ymin, xmax, ymax = extent
    ncols, nrows, _ = target_square_grid(xmin, ymin, xmax, ymax, resolution)

    logger.info(
        "Landscape fetch: extent=[%.2f,%.2f,%.2f,%.2f] %dx%d, roost=[%.2f,%.2f], radius=%.0f",
        xmin, ymin, xmax, ymax, ncols, nrows, easting, northing, radius,
    )

    rasters = [
        ("dtm", cfg.get("dtm_table", "dtm")),
        ("dsm", cfg.get("dsm_table", "dsm")),
        ("lcm", cfg.get("lcm_table", "lcm")),
    ]
    vectors = [
        ("buildings", cfg.get("buildings_table")),
        ("generic_resistance", None),
        ("roads", cfg.get("roads_table")),
        ("rivers", cfg.get("rivers_table")),
    ]

    conn = _connect(cfg)
    try:
        transform, ncols, nrows = fetch_raster_stack(conn, work_dir, rasters, extent, resolution)
        _write_tiff_sidecar(work_dir, transform, nrows, ncols)
        fetch_vector_stack(conn, work_dir, vectors, extent)
    finally:
        conn.close()

    logger.info("Landscape data fetch complete for %s", work_dir)
