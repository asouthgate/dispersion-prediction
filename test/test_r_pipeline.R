#!/usr/bin/env Rscript
#
# Test 1: R pipeline direct test.
# Runs the resistance pipeline end-to-end using seed data from PostGIS.
#
# Prerequisites:
#   1. Stack must be running (docker compose up -d)
#   2. Seed data must be loaded (python test/run-test-stack.py seed)
#
# Usage:
#   Rscript test/test_r_pipeline.R
#   (or via: docker compose exec batapp Rscript test/test_r_pipeline.R)
#

library(testthat)
library(logger)

logger::log_threshold(DEBUG)
logger::log_info("=== Test 1: R pipeline direct test ===")

source("R/algorithm_parameters.R")
source("R/db.R")
source("R/transform.R")
source("R/rasterfunc.R")
source("R/resistance.R")
source("R/pipeline.R")
source("R/write_outputs.R")

logger::log_info("Reading database config...")
config <- configr::read.config("~/.bats.cfg")
db_host <- config$database$host
db_name <- config$database$name
db_pass <- config$database$password
db_user <- config$database$user
db_port <- config$database$port

logger::log_info("Database: %s@%s:%s/%s", db_user, db_host, db_port, db_name)


test_that("Resistance pipeline produces expected output layers", {

    resolution <- 10
    roost_bng <- list(x = 287500, y = 74500)
    radius <- 500

    logger::log_info("Creating algorithm parameters...")
    algorithm_parameters <- AlgorithmParameters$new(
        Roost$new(roost_bng$x, roost_bng$y, radius),
        RoadResistance$new(buffer = 200, resmax = 10, xmax = 5),
        RiverResistance$new(buffer = 10, resmax = 2000, xmax = 4),
        LandscapeResistance$new(rankmax = 8, resmax = 100, xmax = 5),
        LinearResistance$new(buffer = 10, resmax = 22000, rankmax = 4, xmax = 3),
        LampResistance$new(resmax = 1e8, xmax = 1, ext = 100),
        resolution = resolution,
        n_circles = 5
    )

    logger::log_info("Creating extent...")
    ext <- create_extent(roost_bng$x, roost_bng$y, radius)
    algorithm_parameters$extent <- ext

    working_dir <- "/tmp/circuitscape/test_output"
    dir.create(working_dir, recursive = TRUE, showWarnings = FALSE)
    dir.create(file.path(working_dir, "circuitscape"), recursive = TRUE)
    dir.create(file.path(working_dir, "images"), recursive = TRUE)

    logger::log_info("Working directory: %s", working_dir)

    logger::log_info("Creating ground raster...")
    groundrast <- create_ground_rast(roost_bng$x, roost_bng$y, radius, resolution)

    expect_false(is.null(groundrast))
    expect_equal(res(groundrast), c(resolution, resolution))

    logger::log_info("Fetching vector inputs from database...")
    vector_inp <- suppressWarnings(
        fetch_vector_inputs(algorithm_parameters, working_dir)
    )

    expect_true(is.list(vector_inp))
    expect_true("roads" %in% names(vector_inp))

    logger::log_info("Fetching raster inputs from database...")
    raster_inp <- suppressWarnings(
        fetch_raster_inputs(algorithm_parameters, groundrast, working_dir)
    )

    expect_true(is.list(raster_inp))
    expect_true("r_dsm" %in% names(raster_inp))
    expect_true("r_dtm" %in% names(raster_inp))

    if (raster_inp$raster_failed) {
        logger::log_warn("Some raster data failed to load - coverage may be incomplete")
    }

    logger::log_info("Post-processing inputs...")
    set.seed(42)
    n_lamps <- 10
    lamps <- data.frame(
        x = runif(n_lamps, roost_bng$x - radius + 50, roost_bng$x + radius - 50),
        y = runif(n_lamps, roost_bng$y - radius + 50, roost_bng$y + radius - 50),
        z = runif(n_lamps, 2, 15)
    )
    logger::log_info("Generated %d random lamps within study area", nrow(lamps))
    spdfs <- list(buildings = NULL, roads = NULL, rivers = NULL, lights = NULL)
    base_inputs <- suppressWarnings(
        postprocess_inputs(algorithm_parameters, groundrast, vector_inp, raster_inp, working_dir, lamps, spdfs)
    )

    expect_true(is.list(base_inputs))
    expect_true("groundrast" %in% names(base_inputs))
    expect_true("circles" %in% names(base_inputs))
    expect_true("disk" %in% names(base_inputs))

    logger::log_info("Computing resistance rasters...")
    resistance_maps <- cal_resistance_rasters(algorithm_parameters, working_dir, base_inputs, save_images = TRUE)

    expected_layers <- c(
        "road_res", "river_res", "landscape_res", "linear_res",
        "lamp_res", "total_res", "buildings", "soft_surf", "hard_surf",
        "log_point_irradiance"
    )

    for (layer_name in expected_layers) {
        expect_true(
            layer_name %in% names(resistance_maps),
            info = paste("Expected layer", layer_name, "in resistance_maps")
        )
        rast <- resistance_maps[[layer_name]]
        expect_s4_class(rast, "RasterLayer")

        n_vals <- length(raster::values(rast))
        n_non_na <- sum(!is.na(raster::values(rast)))
        logger::log_info("  %s: %d pixels, %d non-NA", layer_name, n_vals, n_non_na)
    }

    logger::log_info("All resistance layers produced successfully.")

    write_pipeline_outputs(resistance_maps, raster_inp, working_dir)

    for (layer_name in expected_layers) {
        expect_true(file.exists(file.path(working_dir, paste0(layer_name, ".tif"))),
                    info = paste("TIF missing:", layer_name))
    }
    expect_true(file.exists(file.path(working_dir, "dsm.tif")))
    expect_true(file.exists(file.path(working_dir, "dtm.tif")))
    expect_true(file.exists(file.path(working_dir, "lcm_r.tif")))

    logger::log_info("Output rasters written to %s", working_dir)

    logger::log_info("Test 1 passed: R pipeline produces all expected layers.")
})

logger::log_info("=== Test 1 complete ===")
