"""PostGIS database service for raster and vector data queries."""

import logging
import struct
from typing import Any

logger = logging.getLogger(__name__)


def get_db_connection():
    """Create a database connection from environment config."""
    import os
    import psycopg2

    return psycopg2.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=int(os.environ.get("DB_PORT", "5432")),
        dbname=os.environ.get("DB_NAME", "bats"),
        user=os.environ.get("DB_USER", "postgres"),
        password=os.environ.get("DB_PASSWORD", ""),
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

    version = struct.unpack_from(endian + 'H', wkb, pos)[0]
    pos += 2

    num_bands = struct.unpack_from(endian + 'H', wkb, pos)[0]
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


# pixtype mapping
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


def fetch_rasters(extent: tuple[float, float, float, float], resolution: float, work_dir: str) -> dict[str, str]:
    """Fetch raster data (DTM, DSM, LCM) from PostGIS and save as GeoTIFF."""
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    conn = get_db_connection()
    xmin, ymin, xmax, ymax = extent
    rasters: dict[str, str] = {}

    try:
        for table in ["dtm", "dsm", "lcm"]:
            try:
                cursor = conn.cursor()
                cursor.execute(f"""
                    WITH merged AS (
                        SELECT ST_Union(rast) as rast
                        FROM {table}
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
                """, (xmin, ymin, xmax, ymax, xmin, ymin, xmax, ymax, resolution, resolution))

                row = cursor.fetchone()
                cursor.close()
                if not row:
                    continue

                width, height = row[0], row[1]
                ulx, uly = row[2], row[3]
                scalex, scaley = row[4], row[5]
                srid = row[6]
                wkb = row[7]

                if not width or not height or not wkb:
                    continue

                pixtype, nodata, pixel_data = _parse_wkb_raster(bytes(wkb))
                dtype_str, elem_size = PIXTYPE_DTYPE.get(pixtype, ('float32', 4))
                expected_size = width * height * elem_size

                if len(pixel_data) < expected_size:
                    logger.warning(f"Pixel data too small for {table}: got {len(pixel_data)}, expected {expected_size}")
                    continue

                pixel_data = pixel_data[:expected_size]
                arr = np.frombuffer(pixel_data, dtype=np.dtype(dtype_str)).reshape((height, width))
                if nodata is not None:
                    arr = np.where(arr == nodata, np.nan, arr)

                out_path = f"{work_dir}/{table}.tif"
                transform = from_origin(ulx, uly, abs(scalex) if scalex else resolution,
                                        abs(scaley) if scaley else resolution)
                profile = {
                    'driver': 'GTiff', 'width': width, 'height': height, 'count': 1,
                    'dtype': arr.dtype.name, 'crs': f'EPSG:{srid}' if srid else None,
                    'transform': transform, 'compress': 'LZW',
                }
                with rasterio.open(out_path, 'w', **profile) as dst:
                    dst.write(arr, 1)

                rasters[table] = out_path

            except Exception as e:
                conn.rollback()
                logger.warning(f"Failed to fetch raster {table}: {e}")

    finally:
        conn.close()

    return rasters
