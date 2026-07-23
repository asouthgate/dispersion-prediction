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

logger::log_threshold(DEBUG)
logger::log_info("=== Resistance pipeline (JSON) ===")

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

logger::log_info("Reading drawn features from GeoPackage files...")
spdfs <- list(buildings = NULL, roads = NULL, rivers = NULL, lights = NULL)

read_gpkg_if_exists <- function(cat, working_dir) {
    gpkg_path <- file.path(working_dir, paste0("drawn_", tolower(cat), ".gpkg"))
    if (!file.exists(gpkg_path)) {
        logger::log_debug("No drawn %s GPKG found at %s", cat, gpkg_path)
        return(NULL)
    }
    logger::log_info("Reading drawn %s from %s", cat, gpkg_path)
    sf_obj <- sf::st_read(gpkg_path, quiet = TRUE)
    if (is.null(sf_obj) || nrow(sf_obj) == 0) return(NULL)
    return(sf_obj)
}

for (cat in c("Building", "Road", "River", "Lights", "LightSequence")) {
    sf_obj <- read_gpkg_if_exists(cat, working_dir)
    if (is.null(sf_obj)) next

    if (cat == "Lights") {
        coords <- sf::st_coordinates(sf_obj)
        z_vals <- if ("height" %in% colnames(sf_obj)) sf_obj$height else rep(0, nrow(coords))
        extra_lamps <- data.frame(x = coords[, "X"], y = coords[, "Y"], z = z_vals)
        logger::log_info("Adding %d lights from GPKG", nrow(extra_lamps))
        lamps <- rbind(lamps, extra_lamps)
    } else if (cat == "LightSequence") {
        extra_lamps <- list()
        for (fi in seq_len(nrow(sf_obj))) {
            feat <- sf_obj[fi, ]
            feat_coords <- sf::st_coordinates(feat)
            nc <- nrow(feat_coords)
            if (nc < 2) next
            h <- if ("height" %in% colnames(feat)) feat$height[1] else 0
            sp <- if ("spacing" %in% colnames(feat)) feat$spacing[1] else 50
            for (seg in seq_len(nc - 1)) {
                x1 <- feat_coords[seg, "X"]; y1 <- feat_coords[seg, "Y"]
                x2 <- feat_coords[seg + 1, "X"]; y2 <- feat_coords[seg + 1, "Y"]
                dx <- x2 - x1; dy <- y2 - y1
                seg_len <- sqrt(dx^2 + dy^2)
                n_points <- max(1, floor(seg_len / sp))
                for (pi in seq_len(n_points)) {
                    t <- pi / n_points
                    extra_lamps[[length(extra_lamps) + 1]] <- c(x1 + t * dx, y1 + t * dy, h)
                }
            }
        }
        if (length(extra_lamps) > 0) {
            extra_df <- as.data.frame(do.call(rbind, extra_lamps))
            colnames(extra_df) <- c("x", "y", "z")
            logger::log_info("Adding %d lights interpolated from LightSequence GPKG", nrow(extra_df))
            lamps <- rbind(lamps, extra_df)
        }
    } else {
        sp_obj <- as(sf_obj, "Spatial")
        spdfs[[cat]] <- sp_obj
        logger::log_info("Added %d drawn %s features", nrow(sf_obj), cat)
    }
}

logger::log_info("Post-processing inputs...")
base_inputs <- suppressWarnings(
    postprocess_inputs(algorithm_parameters, groundrast, vector_inp, raster_inp, working_dir, lamps, spdfs)
)

logger::log_info("Computing resistance rasters...")
resistance_maps <- cal_resistance_rasters(algorithm_parameters, working_dir, base_inputs, save_images = FALSE)

write_pipeline_outputs(resistance_maps, raster_inp, working_dir, disk = base_inputs$disk)

logger::log_info("=== Resistance pipeline complete ===")
