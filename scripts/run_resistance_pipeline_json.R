#!/usr/bin/env Rscript
#
# Full resistance pipeline from JSON input.
# Called by the API: Rscript scripts/run_resistance_pipeline_json.R <work_dir>/inputs.json
#
# Reads roost (BNG), params, and optional lamps from inputs.json,
# runs the full pipeline, and writes all result GeoTIFFs to the working directory.

library(testthat)
library(logger)
library(jsonlite)

logger::log_threshold(DEBUG)
logger::log_info("=== Resistance pipeline (JSON) ===")

source("R/algorithm_parameters.R")
source("R/db.R")
source("R/transform.R")
source("R/rasterfunc.R")
source("R/resistance.R")
source("R/pipeline.R")
source("R/write_outputs.R")

args <- commandArgs(trailingOnly = TRUE)
input_path <- args[1]
working_dir <- dirname(input_path)

logger::log_info("Input: %s", input_path)
logger::log_info("Working dir: %s", working_dir)

dir.create(file.path(working_dir, "images"), recursive = TRUE, showWarnings = FALSE)
dir.create(file.path(working_dir, "circuitscape"), recursive = TRUE, showWarnings = FALSE)

inputs <- jsonlite::fromJSON(input_path, simplifyVector = FALSE)

roost_bng <- inputs$roost
roost_bng$easting <- round(roost_bng$easting)
roost_bng$northing <- round(roost_bng$northing)
resolution <- inputs$params$resolution
if (is.null(resolution)) {
    resolution <- 10
}
n_circles <- inputs$params$n_circles
if (is.null(n_circles)) {
    n_circles <- 5
}

lamps_raw <- inputs$lamps
if (is.null(lamps_raw) || length(lamps_raw) == 0) {
    lamps <- data.frame(x = numeric(0), y = numeric(0), z = numeric(0))
} else {
    lamps <- as.data.frame(do.call(rbind, lapply(lamps_raw, as.numeric)))
    colnames(lamps) <- c("x", "y", "z")
    logger::log_info("Using %d lamps from input", nrow(lamps))
}

logger::log_info("Creating algorithm parameters...")
algorithm_parameters <- AlgorithmParameters$new(
    Roost$new(roost_bng$easting, roost_bng$northing, roost_bng$radius),
    RoadResistance$new(buffer = 200, resmax = 10, xmax = 5),
    RiverResistance$new(buffer = 10, resmax = 2000, xmax = 4),
    LandscapeResistance$new(rankmax = 8, resmax = 100, xmax = 5),
    LinearResistance$new(buffer = 10, resmax = 22000, rankmax = 4, xmax = 3),
    LampResistance$new(resmax = 1e8, xmax = 1, ext = 100),
    resolution = resolution,
    n_circles = n_circles
)

logger::log_info("Creating extent...")
ext <- create_extent(roost_bng$easting, roost_bng$northing, roost_bng$radius)
algorithm_parameters$extent <- ext

logger::log_info("Creating ground raster...")
groundrast <- create_ground_rast(roost_bng$easting, roost_bng$northing, roost_bng$radius, resolution)

if (is.null(groundrast)) {
    stop("Failed to create ground raster")
}

logger::log_info("Fetching vector inputs from database...")
vector_inp <- suppressWarnings(
    fetch_vector_inputs(algorithm_parameters, working_dir)
)

logger::log_info("Fetching raster inputs from database...")
raster_inp <- suppressWarnings(
    fetch_raster_inputs(algorithm_parameters, groundrast, working_dir)
)

if (raster_inp$raster_failed) {
    logger::log_warn("Some raster data failed to load - coverage may be incomplete")
}

logger::log_info("Post-processing inputs...")
spdfs <- list(buildings = NULL, roads = NULL, rivers = NULL, lights = NULL)
base_inputs <- suppressWarnings(
    postprocess_inputs(algorithm_parameters, groundrast, vector_inp, raster_inp, working_dir, lamps, spdfs)
)

logger::log_info("Computing resistance rasters...")
resistance_maps <- cal_resistance_rasters(algorithm_parameters, working_dir, base_inputs, save_images = FALSE)

write_pipeline_outputs(resistance_maps, raster_inp, working_dir)

logger::log_info("=== Resistance pipeline complete ===")
