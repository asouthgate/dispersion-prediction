"""PostGIS database service for raster and vector data queries."""

import os
import logging
import numpy as np
import rasterio
import struct
from rasterio.transform import from_origin
from psycopg2 import sql

from config import DTM_TABLE, DSM_TABLE, LCM_TABLE, DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD

logger = logging.getLogger(__name__)


def get_db_connection():
    """Create a database connection from config (loaded from ~/.bats.cfg)."""
    import psycopg2

    return psycopg2.connect(
        host=DATABASE_HOST,
        port=DATABASE_PORT,
        dbname=DATABASE_NAME,
        user=DATABASE_USER,
        password=DATABASE_PASSWORD,
    )


def _parse_wkb_raster(wkb: bytes) -> tuple[int, float | None, bytes]:
    """Parse WKB raster band and return (pixtype, nodata, pixel_data).
    
    WKB format per PostGIS docs:
    - 1 byte: endianness
    - 2 bytes: version (uint16)
    - 2 bytes: number of bands (uint16)
    - Per band:
      - 1 bit: is_offline
      - 4 bits: has_nodata
      - 11 bits: reserved
      - 2 bytes: pixtype (uint16)
      - If has_nodata: 8 bytes nodata (float64)
      - Pixel data (remaining bytes)
    """
    pos = 0
    endian = '<' if wkb[pos] == 1 else '>'
    pos += 1

    # Unused but here for stream advancement
    _ = struct.unpack_from(endian + 'H', wkb, pos)[0]
    pos += 2
    _ = struct.unpack_from(endian + 'H', wkb, pos)[0]
    pos += 2

    # Band header: 2 bytes of flags
    band_flags = struct.unpack_from(endian + 'H', wkb, pos)[0]
    pos += 2

    is_offline = (band_flags >> 15) & 1
    has_nodata = (band_flags >> 10) & 1

    # Pixtype: 2 bytes
    pixtype = struct.unpack_from(endian + 'H', wkb, pos)[0]
    pos += 2

    nodata = None
    if has_nodata and not is_offline:
        nodata = struct.unpack_from(endian + 'd', wkb, pos)[0]
        pos += 8

    pixel_data = wkb[pos:]
    return pixtype, nodata, pixel_data


PIXTYPE_DTYPE = {
    0: ('uint8', 1),     # 1BB
    1: ('uint16', 2),    # 2BUI
    2: ('int16', 2),     # 2BSI
    3: ('uint32', 4),    # 4BUI
    4: ('int32', 4),     # 4BSI
    5: ('float32', 4),   # 32BF
    6: ('float64', 8),   # 64BF
    7: ('uint16', 2),    # 8BUI
    8: ('int16', 2),     # 8BSI
    10: ('int16', 2),    # 16BSI
    11: ('uint32', 4),   # 32BUI
    12: ('int32', 4),    # 32BSI
    13: ('float32', 4),  # 32BF
    14: ('float64', 8),  # 64BF
}

def _write_geotiff(out_path: str, row: tuple, resolution: float) -> bool:
    """Processes raw WKB raster row data and writes it out as a GeoTIFF."""

    width, height, ulx, uly, scalex, scaley, srid, wkb = row

    if not width or not height or not wkb:
        return False

    pixtype, nodata, pixel_data = _parse_wkb_raster(bytes(wkb))
    dtype_str, elem_size = PIXTYPE_DTYPE.get(pixtype, ('float32', 4))
    expected_size = width * height * elem_size

    if len(pixel_data) < expected_size:
        logger.warning(f"Pixel data too small: got {len(pixel_data)}, expected {expected_size}")
        return False

    pixel_data = pixel_data[:expected_size]
    arr = np.frombuffer(pixel_data, dtype=np.dtype(dtype_str)).reshape((height, width))
    
    if nodata is not None:
        arr = np.where(arr == nodata, np.nan, arr)

    transform = from_origin(
        ulx, uly, 
        abs(scalex) if scalex else resolution,
        abs(scaley) if scaley else resolution
    )
    
    profile = {
        'driver': 'GTiff', 'width': width, 'height': height, 'count': 1,
        'dtype': arr.dtype.name, 'crs': f'EPSG:{srid}' if srid else None,
        'transform': transform, 'compress': 'LZW',
    }
    
    with rasterio.open(out_path, 'w', **profile) as dst:
        dst.write(arr, 1)
        
    return True


def fetch_rasters(extent: tuple[float, float, float, float], resolution: float, work_dir: str,
                  tables: list[tuple[str, str]] | None = None) -> dict[str, str]:
    """Fetch raster data from PostGIS and save as GeoTIFF.

    Args:
        extent: (xmin, ymin, xmax, ymax) in BNG (EPSG:27700)
        resolution: pixel resolution in meters
        work_dir: directory to save output GeoTIFFs
        tables: list of (table_name, output_key) pairs.
                Defaults to [(DTM_TABLE, "dtm"), (DSM_TABLE, "dsm"), (LCM_TABLE, "lcm")]
                from ~/.bats.cfg (loaded at startup via config module).
    """
    if tables is None:
        tables = [
            (DTM_TABLE, "dtm"),
            (DSM_TABLE, "dsm"),
            (LCM_TABLE, "lcm"),
        ]

    conn = get_db_connection()
    xmin, ymin, xmax, ymax = extent
    rasters: dict[str, str] = {}

    try:
        for table, key in tables:
            try:
                query = sql.SQL("""
                    WITH merged AS (
                        SELECT ST_Union(rast) as rast
                        FROM {table_name}
                        WHERE ST_Intersects(rast, ST_MakeEnvelope(%s, %s, %s, %s, 27700))
                    ),
                    clipped AS (
                        SELECT ST_Clip(rast, ST_MakeEnvelope(%s, %s, %s, %s, 27700)) as rast
                        FROM merged WHERE rast IS NOT NULL
                    ),
                    resampled AS (
                        SELECT ST_Resample(rast, %s, %s) as rast
                        FROM clipped WHERE rast IS NOT NULL
                    )
                    SELECT ST_Width(rast), ST_Height(rast),
                           ST_UpperLeftX(rast), ST_UpperLeftY(rast),
                           ST_ScaleX(rast), ST_ScaleY(rast),
                           ST_SRID(rast),
                           ST_AsBinary(ST_Band(rast, 1))
                    FROM resampled
                """).format(table_name=sql.Identifier(table))

                with conn.cursor() as cursor:
                    cursor.execute(query, (xmin, ymin, xmax, ymax, xmin, ymin, xmax, ymax, resolution, resolution))
                    row = cursor.fetchone()

                if not row:
                    logger.warning(f"No raster data for {key} (table={table}) in extent")
                    continue

                out_path = os.path.join(work_dir, f"{key}.tif")

                if _write_geotiff(out_path, row, resolution):
                    rasters[key] = out_path
                    logger.info(f"Fetched {key} from table {table} -> {out_path}")

            except Exception as e:
                conn.rollback()
                logger.error("Failed to fetch raster %s from table %s: %s", key, table, e)
                raise RuntimeError(f"Failed to fetch {key} raster data: database error") from e

    finally:
        conn.close()

    if not rasters:
        logger.error(
            "Coverage query produced zero result layers. Tables checked: %s.",
            [t[0] for t in tables],
        )
        raise RuntimeError(
            "No data is available for the selected area. The database may not have "
            "raster data covering this location."
        )

    return rasters