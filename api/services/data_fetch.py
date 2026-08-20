"""Fetch rasters and vectors from PostGIS for the resistance pipeline.

Writes GeoTIFFs (rasters) and GeoJSON files (vectors) into the work directory
for the wasm-connectivity resistance-pipeline binary to consume.
"""

import io
import json
import logging
import os

import fiona
import numpy as np
import psycopg2
import psycopg2.sql as pgsql
import rasterio
from rasterio.transform import from_bounds
from rasterio.warp import reproject, Resampling
from rasterio.crs import CRS

logger = logging.getLogger(__name__)

DEFAULT_DB_NAME = "bats"


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


def _write_tiff_sidecar(work_dir, xmin, ymax, pixw, nrows, ncols):
    info = {
        "xmin": xmin,
        "ymax": ymax,
        "pixw": pixw,
        "nrows": nrows,
        "ncols": ncols,
    }
    with open(os.path.join(work_dir, "grid_info.json"), "w") as f:
        json.dump(info, f)


def _fetch_raster_as_tiff(conn, table, xmin, ymin, xmax, ymax, ncols, nrows):
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
            arr = np.zeros((nrows, ncols), dtype=np.float32)

        transform = from_bounds(rxmin, rymin, rxmax, rymax, ncols, nrows)
        buf = io.BytesIO()
        with rasterio.open(
            buf, "w", driver="GTiff", height=nrows, width=ncols,
            count=1, dtype=np.float32, crs="EPSG:27700",
            transform=transform, nodata=-9999.0,
        ) as dst:
            dst.write(arr, 1)
        return buf.getvalue()
    finally:
        cur.close()


def _fetch_vector_as_geojson(conn, table, layer_name, xmin, ymin, xmax, ymax):
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


def _merge_drawn_features(work_dir, geojson_files):
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


def _resample_to_grid(src_path, ref_transform, ref_width, ref_height, dst_crs="EPSG:27700"):
    """Resample a raster to match a reference grid, overwriting the file in place."""
    dst_path = src_path + ".resampled"
    try:
        with rasterio.open(src_path) as src:
            src_data = src.read(1)
            logger.debug(
                "_resample_to_grid: %s src=(%dx%d, bounds=[%.2f,%.2f,%.2f,%.2f]) "
                "→ ref=(%dx%d, bounds=[%.2f,%.2f,%.2f,%.2f])",
                os.path.basename(src_path),
                src.width, src.height,
                src.bounds.left, src.bounds.bottom, src.bounds.right, src.bounds.top,
                ref_width, ref_height,
                ref_transform.c, ref_transform.f - ref_height * abs(ref_transform.e),
                ref_transform.c + ref_width * abs(ref_transform.a), ref_transform.f,
            )

            dst_data = np.empty((ref_height, ref_width), dtype=src_data.dtype)

            reproject(
                source=src_data,
                destination=dst_data,
                src_transform=src.transform,
                src_crs=src.crs,
                dst_transform=ref_transform,
                dst_crs=CRS.from_string(dst_crs),
                resampling=Resampling.bilinear,
                src_nodata=src.nodata or -9999.0,
                dst_nodata=-9999.0,
            )

        with rasterio.open(
            dst_path,
            "w",
            driver="GTiff",
            height=ref_height,
            width=ref_width,
            count=1,
            dtype=src_data.dtype,
            crs=dst_crs,
            transform=ref_transform,
            nodata=-9999.0,
        ) as dst:
            dst.write(dst_data, 1)

        os.replace(dst_path, src_path)
        logger.debug("_resample_to_grid: wrote resampled %s", os.path.basename(src_path))
    except Exception as e:
        logger.warning("Failed to resample %s: %s", src_path, e)
        if os.path.exists(dst_path):
            os.unlink(dst_path)


def fetch_resistance_inputs(work_dir: str):
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

    ncols = int((xmax - xmin) / resolution)
    nrows = int((ymax - ymin) / resolution)
    pixw = resolution

    logger.info(
        "Requested extent: xmin=%.2f ymin=%.2f xmax=%.2f ymax=%.2f "
        "(roost=[%.2f,%.2f], radius=%.0f, resolution=%.0f → %dx%d)",
        xmin, ymin, xmax, ymax,
        easting, northing, radius, resolution, ncols, nrows,
    )

    conn = _connect(cfg)
    ref_transform = None

    try:
        for name in ["dtm", "dsm", "lcm"]:
            table = cfg.get(f"{name}_table", name)
            logger.info("Fetching %s raster from %s...", name, table)
            tiff_bytes = _fetch_raster_as_tiff(
                conn, table, xmin, ymin, xmax, ymax, ncols, nrows
            )

            out_path = os.path.join(work_dir, f"{name}.tif")

            if tiff_bytes is None:
                logger.warning("%s returned no data, writing zeros", name)
                arr = np.zeros((nrows, ncols), dtype=np.float32)
                if ref_transform is None:
                    ref_transform = from_bounds(xmin, ymin, xmax, ymax, ncols, nrows)
                with rasterio.open(
                    out_path, "w", driver="GTiff", height=nrows, width=ncols,
                    count=1, dtype=np.float32, crs="EPSG:27700",
                    transform=ref_transform, nodata=-9999.0,
                ) as dst:
                    dst.write(arr, 1)
                logger.info(
                    "Wrote %s.tif (%dx%d) — zeros (no data returned), bounds=[%.2f,%.2f,%.2f,%.2f]",
                    name, ncols, nrows,
                    ref_transform.c, ref_transform.f - nrows * abs(ref_transform.e),
                    ref_transform.c + ncols * abs(ref_transform.a), ref_transform.f,
                )
            else:
                with open(out_path, "wb") as f:
                    f.write(tiff_bytes)

                with rasterio.open(out_path) as src:
                    logger.info(
                        "Wrote %s.tif (%dx%d), bounds=[%.2f,%.2f,%.2f,%.2f], "
                        "crs=%s, nodata=%s",
                        name, src.width, src.height,
                        src.bounds.left, src.bounds.bottom,
                        src.bounds.right, src.bounds.top,
                        src.crs, src.nodata,
                    )
                    if ref_transform is None and name == "dtm":
                        ref_transform = src.transform

        if ref_transform is None:
            ref_transform = from_bounds(xmin, ymin, xmax, ymax, ncols, nrows)

        _write_tiff_sidecar(work_dir, ref_transform.c, ref_transform.f, abs(ref_transform.a), nrows, ncols)

        for name in ["dsm", "lcm"]:
            path = os.path.join(work_dir, f"{name}.tif")
            if os.path.exists(path):
                _resample_to_grid(path, ref_transform, ncols, nrows)

        geojson_files = []
        for table_key, out_name in [
            ("roads_table", "roads"),
            ("rivers_table", "rivers"),
            ("buildings_table", "buildings"),
        ]:
            table = cfg.get(table_key)
            if not table:
                continue
            logger.info("Fetching %s vectors from %s...", out_name, table)
            gj = _fetch_vector_as_geojson(
                conn, table, out_name, xmin, ymin, xmax, ymax
            )
            path = os.path.join(work_dir, f"{out_name}.geojson")
            if gj is None:
                gj = json.dumps({"type": "FeatureCollection", "features": []})
            with open(path, "w") as f:
                f.write(gj)
            geojson_files.append(path)
            logger.info("Wrote %s (%d bytes)", f"{out_name}.geojson", len(gj))

        generic_path = os.path.join(work_dir, "generic_resistance.geojson")
        with open(generic_path, "w") as f:
            json.dump({"type": "FeatureCollection", "features": []}, f)
        geojson_files.append(generic_path)

        _merge_drawn_features(work_dir, geojson_files)

    finally:
        conn.close()

    logger.info("Data fetch complete for %s", work_dir)


def fetch_coverage_inputs(work_dir: str):
    """Fetch DTM/DSM rasters from PostGIS for the coverage stage."""
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

    ncols = int((xmax - xmin) / resolution)
    nrows = int((ymax - ymin) / resolution)

    logger.info(
        "Coverage fetch: extent=[%.2f,%.2f,%.2f,%.2f] %dx%d, roost=[%.2f,%.2f], radius=%.0f",
        xmin, ymin, xmax, ymax, ncols, nrows, easting, northing, radius,
    )

    conn = _connect(cfg)
    try:
        for name in ["dtm", "dsm"]:
            table = cfg.get(f"{name}_table", name)
            logger.info("Fetching %s raster from %s...", name, table)
            tiff_bytes = _fetch_raster_as_tiff(
                conn, table, xmin, ymin, xmax, ymax, ncols, nrows
            )
            out_path = os.path.join(work_dir, f"{name}.tif")
            if tiff_bytes is None:
                logger.warning("%s returned no data, writing zeros", name)
                arr = np.zeros((nrows, ncols), dtype=np.float32)
                transform = from_bounds(xmin, ymin, xmax, ymax, ncols, nrows)
                with rasterio.open(
                    out_path, "w", driver="GTiff", height=nrows, width=ncols,
                    count=1, dtype=np.float32, crs="EPSG:27700",
                    transform=transform, nodata=-9999.0,
                ) as dst:
                    dst.write(arr, 1)
            else:
                with open(out_path, "wb") as f:
                    f.write(tiff_bytes)
    finally:
        conn.close()

    logger.info("Coverage data fetch complete for %s", work_dir)


def fetch_landscape_inputs(work_dir: str):
    """Fetch DTM/DSM/LCM rasters and building/road/river vectors for landscape computation.

    Fetches coverage rasters and rasterizes vector features from PostGIS.
    User-drawn features (from GPKG files) are merged on top of the DB-sourced data.
    """
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

    ncols = int((xmax - xmin) / resolution)
    nrows = int((ymax - ymin) / resolution)
    pixw = resolution

    logger.info(
        "Landscape fetch: extent=[%.2f,%.2f,%.2f,%.2f] %dx%d, roost=[%.2f,%.2f], radius=%.0f",
        xmin, ymin, xmax, ymax, ncols, nrows, easting, northing, radius,
    )

    conn = _connect(cfg)
    ref_transform = None

    try:
        for name in ["dtm", "dsm", "lcm"]:
            table = cfg.get(f"{name}_table", name)
            logger.info("Fetching %s raster from %s...", name, table)
            tiff_bytes = _fetch_raster_as_tiff(
                conn, table, xmin, ymin, xmax, ymax, ncols, nrows
            )

            out_path = os.path.join(work_dir, f"{name}.tif")

            if tiff_bytes is None:
                logger.warning("%s returned no data, writing zeros", name)
                arr = np.zeros((nrows, ncols), dtype=np.float32)
                if ref_transform is None:
                    ref_transform = from_bounds(xmin, ymin, xmax, ymax, ncols, nrows)
                with rasterio.open(
                    out_path, "w", driver="GTiff", height=nrows, width=ncols,
                    count=1, dtype=np.float32, crs="EPSG:27700",
                    transform=ref_transform, nodata=-9999.0,
                ) as dst:
                    dst.write(arr, 1)
                logger.info(
                    "Wrote %s.tif (%dx%d) — zeros (no data returned), bounds=[%.2f,%.2f,%.2f,%.2f]",
                    name, ncols, nrows,
                    ref_transform.c, ref_transform.f - nrows * abs(ref_transform.e),
                    ref_transform.c + ncols * abs(ref_transform.a), ref_transform.f,
                )
            else:
                with open(out_path, "wb") as f:
                    f.write(tiff_bytes)

                with rasterio.open(out_path) as src:
                    logger.info(
                        "Wrote %s.tif (%dx%d), bounds=[%.2f,%.2f,%.2f,%.2f]",
                        name, src.width, src.height,
                        src.bounds.left, src.bounds.bottom,
                        src.bounds.right, src.bounds.top,
                    )
                    if ref_transform is None and name == "dtm":
                        ref_transform = src.transform

        if ref_transform is None:
            ref_transform = from_bounds(xmin, ymin, xmax, ymax, ncols, nrows)

        for name in ["dsm", "lcm"]:
            path = os.path.join(work_dir, f"{name}.tif")
            if os.path.exists(path):
                _resample_to_grid(path, ref_transform, ncols, nrows)

        _write_tiff_sidecar(work_dir, ref_transform.c, ref_transform.f, abs(ref_transform.a), nrows, ncols)

        buildings_table = cfg.get("buildings_table")
        if buildings_table:
            logger.info("Fetching building vectors from %s...", buildings_table)
            gj = _fetch_vector_as_geojson(
                conn, buildings_table, "buildings", xmin, ymin, xmax, ymax
            )
            if gj:
                path = os.path.join(work_dir, "buildings.geojson")
                with open(path, "w") as f:
                    f.write(gj)
                _merge_drawn_features(work_dir, [path])
                logger.info("Wrote buildings.geojson (%d bytes)", len(gj))
            else:
                logger.warning("No building vectors found")

        generic_path = os.path.join(work_dir, "generic_resistance.geojson")
        with open(generic_path, "w") as f:
            json.dump({"type": "FeatureCollection", "features": []}, f)
        _merge_drawn_features(work_dir, [generic_path])

        roads_table = cfg.get("roads_table")
        roads_path = os.path.join(work_dir, "roads.geojson")
        if roads_table:
            logger.info("Fetching road vectors from %s...", roads_table)
            gj = _fetch_vector_as_geojson(
                conn, roads_table, "roads", xmin, ymin, xmax, ymax
            )
            if gj:
                with open(roads_path, "w") as f:
                    f.write(gj)
                logger.info("Wrote roads.geojson (%d bytes)", len(gj))
            else:
                with open(roads_path, "w") as f:
                    json.dump({"type": "FeatureCollection", "features": []}, f)
                logger.warning("No road vectors found in %s", roads_table)
        _merge_drawn_features(work_dir, [roads_path])

        rivers_table = cfg.get("rivers_table")
        rivers_path = os.path.join(work_dir, "rivers.geojson")
        if rivers_table:
            logger.info("Fetching river vectors from %s...", rivers_table)
            gj = _fetch_vector_as_geojson(
                conn, rivers_table, "rivers", xmin, ymin, xmax, ymax
            )
            if gj:
                with open(rivers_path, "w") as f:
                    f.write(gj)
                logger.info("Wrote rivers.geojson (%d bytes)", len(gj))
            else:
                with open(rivers_path, "w") as f:
                    json.dump({"type": "FeatureCollection", "features": []}, f)
                logger.warning("No river vectors found in %s", rivers_table)
        _merge_drawn_features(work_dir, [rivers_path])

    finally:
        conn.close()

    logger.info("Landscape data fetch complete for %s", work_dir)
