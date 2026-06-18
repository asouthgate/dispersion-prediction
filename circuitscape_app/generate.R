#' Exclude any lamps too far from the roost
#'
#' @param df
#' @param x
#' @param y
#' @param ext=100
#' @param radius
#' @return dataframe with lights that are within a given circle
filter_lamps <- function(lampsdf, x, y, radius, ext=100) {
    logger::log_info(paste("Filtering", nrow(lampsdf), "lamps with", x, y, radius))
    lamps <- lampsdf[(lampsdf$x - x)^2 + (lampsdf$y - y)^2 < (radius + ext)^2, ]
    lamps
}

log_raster <- function(r) {
    # Calculate the log total resistance
    logtotalres <- r
    navals <- is.na(values(logtotalres))
    logtotalres[navals] <- 0
    logtotalres <- logtotalres + 1
    logtotalres <- log(logtotalres)
    logtotalres[navals] <- NA
    logtotalres
}

#' Run the main pipeline asynchronously
#'
#' To prevent the app from freezing up, the pipeline is run async
#'
#' @param session
#' @param input
#' @param progress an AsyncProgress object, regular ShinyProgress will not work with futures
#' @param enable_flags flags used to enable certain UI components
#' @param algorithm_parameters parameters for the algorithm itself
#' @param working_dir working directory where outputs and tmp files are saved
#' @param drawings a DrawingCollection
#' @param lamps an additional csv of lamps
#' @param miv a MapImageViewer object for rendering the results
#' @param currlat the current latitude of the roost
#' @param currlon the current longitude of the roost
#' @param radius the roost radius
#' @param uuid the uuid for the user
async_run_pipeline <- function(session, input, progress, enable_flags, algorithm_parameters, working_dir, drawings,
                                lamps, miv, currlat, currlon, radius, uuid) {

    logger::log_info("Running async pipeline")

    # Get spatial data frames from the collection of drawings
    spdfs <- drawings$get_spatial_dfs(crs = "27700")

    # Show empty modal to get the blanked out screen effect
    showModal(modalDialog(
        title = "",
        "",
        easyClose = FALSE,
        footer = NULL
    ))

    # Reset the map image viewer, if there are previous images on
    miv$reset(session)
    logger::log_info("Reset the miv in first pipeline")

    # Log the positions etc of the clicks
    logger::log_info(paste("A user clicked the generate button with:"))
    logger::log_info(paste0("uuid, lat, lon, radius, resolution, n_buildings_drawn,",
                            "n_rivers_drawn, n_roads_drawn, n_lights_drawn, n_lights_imported"))

    n_buildings <- 0
    n_roads <- 0
    n_rivers <- 0
    n_lights <- 0
    n_imported_lights <- 0

    if (!is.null(lamps)) {n_imported_lights <- nrow(lamps)}
    if (!is.null(spdfs$buildings)) n_buildings <- nrow(spdfs$buildings)
    if (!is.null(spdfs$roads)) n_roads <- nrow(spdfs$roads)
    if (!is.null(spdfs$rivers)) n_rivers <- nrow(spdfs$rivers)
    if (!is.null(spdfs$lights)) n_lights <- nrow(spdfs$lights)

    logger::log_info(paste(uuid, currlat, currlon, radius, algorithm_parameters$resolution,
        n_buildings, n_rivers, n_roads, n_lights, n_imported_lights,
        sep = ","
    ))

    future({

        progress$set(message = "Preparing a few things...", value = 1)

        n_lamps_start <- nrow(lamps)
        lamps <- filter_lamps(lamps, algorithm_parameters$roost$x,
            algorithm_parameters$roost$y, algorithm_parameters$roost$radius)
        n_lamps_filtered <- nrow(lamps)

        logger::log_info(paste("Cut", n_lamps_filtered - n_lamps_start, "lamps that fell outside the radius"))

        input_data_fname <- paste0(working_dir, "/input_data.Rdata")

        # Create an extent, essentially a bounding box
        logger::log_info("Creating extent")
        ext <- create_extent(algorithm_parameters$roost$x, algorithm_parameters$roost$y, algorithm_parameters$roost$radius)
        algorithm_parameters$extent <- ext

        progress$set(message = "Generating ground raster...", value = 2)

        # Generate the ground raster, that is the sink for circuitscape
        # Also used as a kind of template for the resistance map pipeline
        logger::log_info("Generating ground raster...")
        groundrast <- create_ground_rast(algorithm_parameters$roost$x,
                                        algorithm_parameters$roost$y,
                                        algorithm_parameters$roost$radius,
                                        algorithm_parameters$resolution)

        # Fetch vector data from the db
        logger::log_info("Attempting to fetch vector inputs")
        progress$set(message = "Fetching vector data...", value = 3)
        vector_inp <- fetch_vector_inputs(algorithm_parameters, working_dir)

        # Fetch raster data from the db
        logger::log_info("Attempting to fetch faster inputs")
        progress$set(message = "Fetching LIDAR raster data...", value = 4)
        raster_inp <- fetch_raster_inputs(algorithm_parameters, groundrast, working_dir)

        # Add extra height; for the db buildings, height is obtained from lidar data, nothing exists for drawings
        logger::log_info("Getting extra height rasters for extra buildings...")
        progress$set(message = "Combining data from drawings...", value = 5)
        if (!is.null(spdfs$buildings)) {
            extra_height <- get_extra_height_rasters(groundrast, SpatialPolygons(spdfs$buildings@polygons), spdfs$buildings$heights)
            logger::log_info("Adding the extra height from drawings")
            raster_inp$r_dsm <- raster_inp$r_dsm + extra_height
        }

        # Do some more data merging for the extra drawings
        logger::log_info("Combining inputs")
        progress$set(message = "Combining extra inputs...", value = 6)
        print("nlamps")
        print(nrow(lamps))
        base_inputs <- postprocess_inputs(algorithm_parameters, groundrast, vector_inp, raster_inp, working_dir, lamps, spdfs)

        # Save a few data files for separate submission to the resistance pipeline queue
        logger::log_info("Submitting resistance pipeline")
        base_inputs_fname <- paste0(working_dir, "/base_inputs.Rdata")
        save(working_dir, algorithm_parameters, base_inputs, file = base_inputs_fname)

        progress$set(message = "Submitting to the resistance pipeline...", value = 7)
        submit_resistance_pipeline(base_inputs_fname)

        load(paste0(working_dir, "/resistance_maps.Rdata"))

        logger::log_info("Precomputing images for map")
        progress$set(message = "Processing images...", value = 8)
        logger::log_info("Added miv initial data")

        resistance_maps$dsm <- raster_inp$r_dsm
        resistance_maps$dtm <- raster_inp$r_dtm

        resistance_maps$log_lamp_res <- log_raster(resistance_maps$lamp_res)

        resistance_maps$log_total_res <- log_raster(resistance_maps$total_res)

        list(resistance_maps = resistance_maps, disk = base_inputs$disk, raster_failed = raster_inp$raster_failed)

    }) %...>% (function(li) {

        # Remove the modal background
        removeModal()

        resistance_maps <- li$resistance_maps
        raster_failed <- li$raster_failed
        disk <- li$disk

        logger::log_info("Handling promise...")

        number_of_dsm_nulls <- length(is.na(values(resistance_maps$dsm)))
        percentage_coverage <- 1 - (number_of_dsm_nulls/length(values(resistance_maps$dsm)))

        # # If the raster failed flag is present, we will add a warning
        # if (raster_failed || percentage_coverage < 98) {
        #     removeUI(selector = "#warning_div", immediate = TRUE)
        #     insertUI(
        #         selector = "#download",
        #         where = "afterEnd",
        #         div(
        #             id="warning_div",
        #             br(),
        #             code("Warning: the requested region does not have full map data coverage!")
        #         )
        #     )
        # }

        progress$set(message = "Adding images to map...", value = 9)

        

        rmaps_to_show <- list(
            "Log Total Resistance"=resistance_maps$log_total_res,
            "Total Resistance"=resistance_maps$total_res,
            "Road Resistance"=resistance_maps$road_res,
            "River Resistance"=resistance_maps$river_res,
            "Landscape Resistance"=resistance_maps$landscape_res,
            "Linear Resistance"=resistance_maps$linear_res,
            "Lamp Resistance"=resistance_maps$lamp_res,
            "Log Lamp Resistance"=resistance_maps$log_lamp_res,
            "DSM"=resistance_maps$dsm,
            "DTM"=resistance_maps$dtm
        )

        miv$load_plain_rasters(input, session, currlon, currlat, radius, rmaps_to_show, disk)
        logger::log_info("Loaded rasters into MIV.")

        leaflet::removeShape(leafletProxy("map"), "roost")

        # Enable the download button
        enable_flags$resistance_complete <- TRUE
        progress$close()
    })
}


async_get_coverage <- function(session, algorithm_parameters, miv, working_dir) {

    logger::log_info("Fetching coverage...")
    
    progress <- AsyncProgress$new(session, min=1, max=10, message="Preparing...", value = 0)

    showModal(modalDialog(
        title = "",
        "",
        easyClose = FALSE,
        footer = NULL
    ))

    future({

        progress$set(message = "Fetching coverage maps...", value = 5)
        logger::log_info("Creating extent")
        ext <- create_extent(algorithm_parameters$roost$x, algorithm_parameters$roost$y, algorithm_parameters$roost$radius)
        algorithm_parameters$extent <- ext

        logger::log_info("Generating ground raster...")
        groundrast <- create_ground_rast(algorithm_parameters$roost$x,
                                        algorithm_parameters$roost$y,
                                        algorithm_parameters$roost$radius,
                                        algorithm_parameters$resolution)

        raster_inp <- fetch_raster_inputs(algorithm_parameters, groundrast, working_dir)

        disk <- create_disk_mask(groundrast, algorithm_parameters$roost$x, algorithm_parameters$roost$y, algorithm_parameters$roost$radius)
        terra::crs(disk) <- sf::st_crs(27700)$proj4string

        images <- list(disk=disk, dsm=raster_inp$r_dsm, dtm=raster_inp$r_dtm)

        images

    }) %...>% (function(images) {

        miv$reset(session)

        progress$set(message = "Adding images...", value = 9)

        miv$set_disk(images$disk)

        dsm <- images$dsm
        dtm <- images$dtm

        miv$add_dsm_dtm(session, dsm, dtm)

        progress$close()
        # disable("generate_curr")
        removeModal()

        leaflet::removeShape(leafletProxy("map"), "roost")

    })
}
