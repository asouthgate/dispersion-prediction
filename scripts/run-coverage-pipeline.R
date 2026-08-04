#!/usr/bin/env Rscript
#
# Coverage pipeline: fetch DTM/DSM/LCM from database and write as GeoTIFFs.
# Called by the API: Rscript scripts/run-coverage-pipeline.R <work_dir>/inputs.json
#
# Reads roost (BNG) and params from inputs.json,
# fetches raster layers resampled to a square ground raster grid,
# and writes dtm.tif, dsm.tif, lcm.tif to the working directory.

library(logger)
library(jsonlite)

source("scripts/user_log.R")

logger::log_threshold(INFO)
user_log_info("Running coverage pipeline")

source("r-pkg/R/algorithm_parameters.R")
source("r-pkg/R/db.R")
source("r-pkg/R/transform.R")
source("r-pkg/R/rasterfunc.R")
source("r-pkg/R/pipeline.R")

args <- commandArgs(trailingOnly = TRUE)
input_path <- args[1]
working_dir <- dirname(input_path)

user_log_info("Input: %s", input_path)
user_log_info("Working dir: %s", working_dir)

dir.create(file.path(working_dir, "images"), recursive = TRUE, showWarnings = FALSE)

inputs <- jsonlite::fromJSON(input_path, simplifyVector = FALSE)

roost_bng <- inputs$roost
roost_bng$easting <- round(roost_bng$easting)
roost_bng$northing <- round(roost_bng$northing)
resolution <- inputs$params$resolution
if (is.null(resolution)) {
    resolution <- 10
}

user_log_info("Creating extent...")
ext <- create_extent(roost_bng$easting, roost_bng$northing, roost_bng$radius)

user_log_info("Creating algorithm parameters...")
algorithm_parameters <- AlgorithmParameters$new(
    Roost$new(roost_bng$easting, roost_bng$northing, roost_bng$radius),
    resolution = resolution
)
algorithm_parameters$extent <- ext

user_log_info("Creating ground raster...")
groundrast <- create_ground_rast(roost_bng$easting, roost_bng$northing, roost_bng$radius, resolution)

if (is.null(groundrast)) {
    stop("Failed to create ground raster")
}

user_log_info("Fetching raster inputs from database...")
raster_inp <- suppressWarnings(
    fetch_raster_inputs(algorithm_parameters, groundrast, working_dir)
)

if (raster_inp$raster_failed) {
    user_log_warn("Some raster data failed to load")
}

user_log_info("Writing coverage GeoTIFFs...")
expected_names <- c("r_dsm", "r_dtm", "r_lcm")
written <- c()
for (name in expected_names) {
    rast <- raster_inp[[name]]
    if (!is.null(rast) && inherits(rast, "RasterLayer")) {
        fname <- sub("^r_", "", name)
        tif_path <- file.path(working_dir, paste0(fname, ".tif"))
        user_log_info("Writing %s -> %s", fname, tif_path)
        raster::writeRaster(rast, tif_path, "GTiff", overwrite = TRUE)
        written <- c(written, fname)
    } else {
        user_log_warn("No data for %s", name)
    }
}

user_log_info("Coverage layers written: %s", paste(written, collapse=", "))
if (length(written) < length(expected_names)) {
    missing <- setdiff(sub("^r_", "", expected_names), written)
    user_log_warn("Missing coverage layers: %s", paste(missing, collapse=", "))
}

user_log_info("Coverage pipeline complete.")
