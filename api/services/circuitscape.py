"""Run Circuitscape (Julia) directly from Python for the current pipeline stage."""

import logging
import os

import numpy as np
import rasterio

logger = logging.getLogger(__name__)

# Circuitscape advanced-mode config. Each occurrence of WORKINGDIR is replaced
# with the job's work directory before the run.
_CS_INI_TEMPLATE = """[Options for advanced mode]
ground_file_is_resistances = True
remove_src_or_gnd = keepall
ground_file = WORKINGDIR/circuitscape/ground.asc
use_unit_currents = False
source_file = WORKINGDIR/circuitscape/source.asc
use_direct_grounds = False

[Mask file]
mask_file = None
use_mask = False

[Calculation options]
low_memory_mode = False
parallelize = False
solver = cholmod
print_timings = False
preemptive_memory_release = False
print_rusages = False
max_parallel = 0

[Short circuit regions (aka polygons)]
use_polygons = False

[Output options]
set_null_currents_to_nodata = False
set_focal_node_currents_to_zero = False
set_null_voltages_to_nodata = False
compress_grids = False
write_cur_maps = 1
write_volt_maps = 0
output_file = WORKINGDIR/circuitscape/cs_out
write_cum_cur_map_only = False
log_transform_maps = False
write_max_cur_maps = False

[Connection scheme for raster habitat data]
connect_using_avg_resistances = True
connect_four_neighbors_only = False

[Habitat raster or graph]
habitat_map_is_resistances = True
habitat_file = WORKINGDIR/circuitscape/resistance.asc

[Circuitscape mode]
data_type = raster
scenario = advanced
"""


def write_cs_ini(work_dir: str) -> str:
    """Write the Circuitscape config file into the work directory."""
    ini_path = os.path.join(work_dir, "cs.ini")
    with open(ini_path, "w") as f:
        f.write(_CS_INI_TEMPLATE.replace("WORKINGDIR", work_dir))
    return ini_path


def julia_command(work_dir: str) -> list[str]:
    """Build the Julia command that runs Circuitscape on the work directory."""
    ini_path = write_cs_ini(work_dir)
    return [
        "julia", "--project=/opt/julia", "-e",
        f'using Circuitscape; compute("{ini_path}")',
    ]


def asc_to_geotiff(asc_path: str, tif_path: str, log_transform: bool = False) -> None:
    """Convert a Circuitscape ASCII output to a GeoTIFF (EPSG:27700)."""
    with rasterio.open(asc_path) as src:
        data = src.read(1).astype(np.float32)
        transform = src.transform
        height, width = data.shape

    if log_transform:
        data = np.log(data + 1.0)

    with rasterio.open(
        tif_path, "w", driver="GTiff", height=height, width=width, count=1,
        dtype="float32", crs="EPSG:27700", transform=transform,
    ) as dst:
        dst.write(data, 1)
