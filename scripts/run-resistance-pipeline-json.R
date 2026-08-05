#!/usr/bin/env Rscript
#
# Full resistance pipeline from JSON input.
# Called by the API: Rscript scripts/run-resistance-pipeline-json.R <work_dir>/inputs.json
#
# Reads roost (BNG), params, and optional lamps from inputs.json,
# runs the full pipeline, and writes all result GeoTIFFs to the working directory.

library(testthat)
library(logger)
library(jsonlite)

source("scripts/user_log.R")

logger::log_threshold(INFO)
user_log_info("Resistance pipeline (JSON)")

source("r-pkg/R/algorithm_parameters.R")
source("r-pkg/R/db.R")
source("r-pkg/R/transform.R")
source("r-pkg/R/rasterfunc.R")
source("r-pkg/R/resistance.R")
source("r-pkg/R/pipeline.R")
source("r-pkg/R/write_outputs.R")

args <- commandArgs(trailingOnly = TRUE)
input_path <- args[1]
working_dir <- dirname(input_path)

logger::log_debug("Input: %s", input_path)
logger::log_debug("Working dir: %s", working_dir)

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

lamps <- data.frame(x = numeric(0), y = numeric(0), z = numeric(0))

user_log_info("Creating algorithm parameters...")
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

user_log_info("Creating extent...")
ext <- create_extent(roost_bng$easting, roost_bng$northing, roost_bng$radius)
algorithm_parameters$extent <- ext

user_log_info("Creating ground raster...")
groundrast <- create_ground_rast(roost_bng$easting, roost_bng$northing, roost_bng$radius, resolution)

if (is.null(groundrast)) {
    stop("Failed to create ground raster")
}

user_log_info("Fetching vector inputs from database...")
vector_inp <- suppressWarnings(
    fetch_vector_inputs(algorithm_parameters, working_dir)
)

user_log_info("Fetching raster inputs from database...")
raster_inp <- suppressWarnings(
    fetch_raster_inputs(algorithm_parameters, groundrast, working_dir)
)

if (raster_inp$raster_failed) {
    user_log_warn("Some raster data failed to load - coverage may be incomplete")
}

user_log_info("Reading drawn features from GeoPackage files...")
spdfs <- list(buildings = NULL, roads = NULL, rivers = NULL, lights = NULL, genericresistance = NULL)

read_gpkg_if_exists <- function(cat, working_dir) {
    gpkg_path <- file.path(working_dir, paste0("drawn_", tolower(cat), ".gpkg"))
    if (!file.exists(gpkg_path)) {
        logger::log_debug("No drawn %s GPKG found at %s", cat, gpkg_path)
        return(NULL)
    }
    logger::log_debug("Reading drawn %s from %s", cat, gpkg_path)
    sf_obj <- sf::st_read(gpkg_path, quiet = TRUE)
    if (is.null(sf_obj) || nrow(sf_obj) == 0) return(NULL)
    return(sf_obj)
}

for (cat in c("Building", "Road", "River", "GenericResistance")) {
    sf_obj <- read_gpkg_if_exists(cat, working_dir)
    if (is.null(sf_obj)) next

    sp_obj <- as(sf_obj, "Spatial")
    if (cat == "GenericResistance") {
        spdfs[["genericresistance"]] <- sp_obj
    } else {
        spdfs[[cat]] <- sp_obj
    }
    user_log_info("Added %d drawn %s features", nrow(sf_obj), cat)
}

user_log_info("Post-processing inputs...")
base_inputs <- suppressWarnings(
    postprocess_inputs(algorithm_parameters, groundrast, vector_inp, raster_inp, working_dir, lamps, spdfs)
)

user_log_info("Computing resistance rasters...")
resistance_maps <- cal_resistance_rasters(algorithm_parameters, working_dir, base_inputs, save_images = FALSE)

write_pipeline_outputs(resistance_maps, raster_inp, working_dir, disk = base_inputs$disk)

user_log_info("Resistance pipeline complete")
