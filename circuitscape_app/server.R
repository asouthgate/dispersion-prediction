#' Main server code
#'

library(leaflet)
library(R6)
library(raster)
library(rpostgis)
library(sf)
library(shiny)
library(shinyBS)
library(shinyjs)
library(stringr)
library(uuid)
library(ipc)

library(promises)
library(future)
plan(multicore)

source("R/algorithm_parameters.R")
source("R/pipeline.R")
source("R/transform.R")
source("R/drawing_collection.R")
source("R/map_image_viewer.R")
source("circuitscape_app/generate.R")
source("R/rasterfunc.R")

if (!interactive()) sink(stderr(), type = "output")

# Required due to a bug when deploying in certain environments
marker_icon <- makeIcon(
  iconUrl = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.8.0-beta.0/images/marker-icon.png",
  shadowUrl = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.8.0-beta.0/images/marker-shadow.png",
  iconAnchorX = 12,
  iconAnchorY = 41
)

#' Create an ST_Point object from x (longitude) and y (latitude) coordinates.
create_st_point <- function(x, y) {
    sf::st_point(c(as.numeric(x), as.numeric(y)))
}

#' Convert x, y coordinates from one EPSG coordinate system to another
convert_point <- function(x, y, source_crs, destination_crs) {
    source_point <- create_st_point(x, y)
    sfc <- sf::st_sfc(source_point, crs = source_crs)
    destination_point <- sf::st_transform(sfc, destination_crs)
    sf::st_coordinates(destination_point)
}

#' Format coordinates to 3 decimal places
format_coordinate <- function(n) {
    if (is.null(n)) return("")
    format(n, digits = 3, nsmall = 3)
}

# The Circuitscape Julia function is parameterised by a .ini file
# that contains the paths of files required to perform the Circuitscape
# algorithm. These working files (including the .ini fie) are stored in a
# different randomly named folder for each use of the app. The file paths
# in the .ini must be customised to use the random working directory. We
# start with a template (cs.ini.template) and replace each occurence of
# WORKINGDIR with the working directory.
prepare_circuitscape_ini_file <- function(working_dir) {
    # Inject the working dir into the file ini template file
    template_filename <- "./R/cs.ini.template"
    template <- readChar(template_filename, file.info(template_filename)$size)
    output <- stringr::str_replace_all(template, "WORKINGDIR", working_dir)
    # Save the injected template in the working dir
    output_filename <- paste0(working_dir, "/cs.ini")
    output_file <- file(output_filename)
    logger::log_info(paste(working_dir, output_filename, output_file))
    logger::log_info(paste("Writing ini file to", output_file))
    writeLines(output, output_file)
    close(output_file)
}

server <- function(input, output, session) {

    # Create uuid and set up temp folders for the session
    uuid <- str_replace_all(UUIDgenerate(), "-", "_")
    logger::log_info(paste("New session created with UUID", uuid))

    working_dir <- paste0("/tmp/circuitscape/", uuid)
    logger::log_info(paste("Creating working_dir:", working_dir))
    dir.create(working_dir, recursive = TRUE)
    dir.create(paste0(working_dir, "/circuitscape"))

    # Disable some buttons at the beginning
    disable("generate_curr")

    lat0 <- 50.604
    lon0 <- -3.600

    # Set up the Leaflet map as a reactive variable
    map <- reactive({
        leaflet(options = leafletOptions()) %>%
        addTiles() %>%
        setView(lng = lon0, lat = lat0, zoom = 13)
    })
    output$map <- renderLeaflet(map())

    # Get the coordinates of the clicked map point in EPSG:4326 (WSG84)
    clicked4326 <- reactive({
        map_click <- input$map_click
        if (is.null(map_click)) return()
        create_st_point(map_click$lng, map_click$lat)
    })

    # Convert the coordinates of the clicked map point to EPSG:27700 (BNG)
    clicked27700 <- reactive({
        req(clicked4326())
        convert_point(clicked4326()[1], clicked4326()[2], 4326, 27700)
    })

    # Values used to remember where the roost was when last clicked
    last_clicked_roost <- reactiveVal(c(lon0, lat0))

    # Observe the latitude input box
    observeEvent(input$latitude_input, {
        lati <- input$latitude_input
        last_clicked_roost(c(last_clicked_roost()[1], lati))
        # TODO: repetition
        proxy <- leafletProxy("map")
        addMarkers(proxy, lng = last_clicked_roost()[1], 
            lat = last_clicked_roost()[2], icon = marker_icon, layerId = "roost")
        addCircles(proxy, lng = last_clicked_roost()[1], 
            lat = last_clicked_roost()[2], weight = 1, radius = as.numeric(input$radius), layerId = "roost")
    })

    # TODO: repetition
    # Observe the longitude input box
    observeEvent(input$longitude_input, {
        loni <- input$longitude_input
        last_clicked_roost(c(loni, last_clicked_roost()[2]))
        proxy <- leafletProxy("map")
        addMarkers(proxy, lng = last_clicked_roost()[1],
                    lat = last_clicked_roost()[2], icon = marker_icon, layerId="roost")
        addCircles(proxy, lng = last_clicked_roost()[1],
                    lat = last_clicked_roost()[2], weight = 1, radius = as.numeric(input$radius), layerId = "roost")
        nepoint <- convert_point(last_clicked_roost()[1], last_clicked_roost()[2], 4326, 27700)
        output$easting <- renderText(nepoint[1])
        output$northing <- renderText(nepoint[2])
    })

    # Populate the roost coordinate text boxes from the map-click location
    output$easting <- renderText(format_coordinate(clicked27700()[1]))
    output$northing <- renderText(format_coordinate(clicked27700()[2]))


    # A collection of drawings for the map
    drawings <- DrawingCollection$new(input, session, leafletProxy("map"))

    # Main map click response code
    observeEvent(input$map_click, {
        logger::log_debug("Clicked on the map.")
        proxy <- leafletProxy("map")
        map_click <- input$map_click
        if (drawings$something_is_selected()) {
            drawings$add_point_complete(map_click$lng, map_click$lat)
        } else {
            last_clicked_roost(c(map_click$lng, map_click$lat))
            addMarkers(proxy, lng = last_clicked_roost()[1], lat = last_clicked_roost()[2], 
                icon = marker_icon, layerId = "roost")
            addCircles(proxy, lng = last_clicked_roost()[1], lat = last_clicked_roost()[2],
                weight = 1, radius = as.numeric(input$radius), layerId = "roost")
            updateNumericInput(session, "latitude_input", value = last_clicked_roost()[2])
            updateNumericInput(session, "longitude_input", value = last_clicked_roost()[1])
        }
    }, ignoreInit = TRUE)

    # Observe if radius changes: redraw and recalculate permissible resolution
    observeEvent(input$radius, {

        proxy <- leafletProxy("map")
        addMarkers(proxy, lng = last_clicked_roost()[1],
            lat = last_clicked_roost()[2], icon = marker_icon, layerId = "roost")
        addCircles(proxy, lng = last_clicked_roost()[1],
            lat = last_clicked_roost()[2], weight = 1, radius = as.numeric(input$radius), layerId = "roost")
        
        max_n_pixel <- 1000000
        max_row_pixel <- sqrt(max_n_pixel)
        d <- input$radius * 2
        min_resolution <- round(max(1, d / max_row_pixel))
        updateSliderInput(session, "resolution", value = max(input$resolution, min_resolution),
        min = min_resolution)

    })

    # Hide the radius circle when the checkbox is unchecked
    observeEvent(input$showRadius, {
        if (!input$showRadius) clearShapes(leafletProxy("map"))
    })

    # Observe if drawing
    observeEvent(input$upload_file, {

        logger::log_info("Got file upload click")

        folder <- dirname(input$upload_file$datapath)

        unzip(input$upload_file$datapath, exdir = folder)

        tryCatch({drawings$read_buildings(folder)},
            error = function(e) { print(e); logger::log_error("No buildings")})
        tryCatch({drawings$read_roads(folder)}, 
            error = function(e) { print(e); logger::log_error("No roads")})
        tryCatch({drawings$read_rivers(folder)}, 
            error = function(e) { print(e); logger::log_error("No rivers")})
        tryCatch({drawings$read_lights(paste0(folder, "/lights.csv"))}, 
            error = function(e) { print(e); logger::log_error("No lights")})

    })

    lamps <- data.frame(x=c(), y=c(), z=c())

    observeEvent(input$streetLightsFile, {
        logger::log_info("Getting street lamps")
        if (!is.null(input$streetLightsFile)) {
            lamps <<- read.csv(input$streetLightsFile$datapath)
            print(tolower(colnames(lamps)))
            if (all(tolower(colnames(lamps)) != c("easting", "northing", "height"))) {
                insertUI(
                    selector = "#slf_hr",
                    where = "afterEnd",
                    div(
                        id="warning_div",
                        br(),
                        code("Warning: uploaded CSV file must contain easting,northing,height columns!")
                    )
                )
            }
            colnames(lamps) <<- c("x", "y", "z")
            # lamps <- vector_convert_points(lamps, 4326, 27700)
            logger::log_info(paste("Got", nrow(lamps), "lamps"))
        }
    })

    # Enable the raster download button when the file to download has been prepared
    enable_flags <- reactiveValues(resistance_complete=FALSE)
    observe({
        if (enable_flags$resistance_complete) {
            enable("generate_curr")
            enable("download")
        } else {
            disable("generate_curr")
            disable("download")
        }
    })

    # A class for adding some rasters to the map
    miv <-  MapImageViewer$new(leafletProxy("map"), input, session)

    observeEvent(input$generate_cov, {

        # TODO: DRY

        # Get roost params
        roost <- last_clicked_roost()
        currlon <- roost[1]
        currlat <- roost[2]
        radius <- input$radius

        miv$set_position(currlon, currlat, radius)

        # Convert to 27700
        northeast <- convert_point(last_clicked_roost()[1], last_clicked_roost()[2], 4326, 27700)
        
        # TODO: should make the ext itself
        algorithm_parameters <- AlgorithmParameters$new(
            Roost$new(northeast[1], northeast[2], radius),
            RoadResistance$new(buffer=input$road_buffer, resmax=input$road_resmax, xmax=input$road_xmax),
            RiverResistance$new(buffer=input$river_buffer, resmax=input$river_resmax, xmax=input$river_xmax),
            LandscapeResistance$new(rankmax=input$landscape_rankmax, resmax=input$landscape_resmax, xmax=input$landscape_xmax),
            LinearResistance$new(buffer=input$linear_buffer, resmax=input$linear_resmax, rankmax=input$linear_rankmax, xmax=input$linear_xmax),
            LampResistance$new(resmax=input$lamp_resmax, xmax=input$lamp_xmax, ext=input$lamp_ext),
            resolution=input$resolution,
            n_circles=input$n_circles
        )

        async_get_coverage(session, algorithm_parameters, miv, working_dir)
    
    })

    observeEvent(input$generate_res, {

        drawings$unselect()

        # Disable completion; can't download while running
        enable_flags$resistance_complete <- FALSE

        # Get roost params
        roost <- last_clicked_roost()
        currlon <- roost[1]
        currlat <- roost[2]
        radius <- input$radius

        # Convert to 27700
        northeast <- convert_point(last_clicked_roost()[1], last_clicked_roost()[2], 4326, 27700)

        # Create algorithm parameters
        algorithm_parameters <- AlgorithmParameters$new(
            Roost$new(northeast[1], northeast[2], radius),
            RoadResistance$new(buffer=input$road_buffer, resmax=input$road_resmax, xmax=input$road_xmax),
            RiverResistance$new(buffer=input$river_buffer, resmax=input$river_resmax, xmax=input$river_xmax),
            LandscapeResistance$new(rankmax=input$landscape_rankmax, resmax=input$landscape_resmax, xmax=input$landscape_xmax),
            LinearResistance$new(buffer=input$linear_buffer, resmax=input$linear_resmax, rankmax=input$linear_rankmax, xmax=input$linear_xmax),
            LampResistance$new(resmax=input$lamp_resmax, xmax=input$lamp_xmax, ext=input$lamp_ext),
            resolution=input$resolution,
            n_circles=input$n_circles
        )

        tryCatch(
            {
                # show_modal_spinner(text="Calculating resistance. This may take a few minutes...", color="#3a3a3d")
                progress <- AsyncProgress$new(session, min=1, max=10, message="Preparing...", value = 0)
                async_run_pipeline(session, input, progress, enable_flags, algorithm_parameters, working_dir, 
                                    drawings, lamps, miv, currlat, currlon, radius, uuid)

            },
            error=function(err) {
                warning(paste('Failed to generate raster :(', err$message))
                logger::log_debug("Failed to generate raster:")
                showNotification(paste('Failed to generate raster :(', err$message), duration=5, type="error")
            }
        )
    })

    observeEvent(input$generate_curr, {
        logger::log_info("Pressed the current generation button...")
        prepare_circuitscape_ini_file(working_dir)
        tryCatch({
                logger::log_info("Calling circuitscape...")
                progress <- AsyncProgress$new(session, min=1, max=10, message="Preparing...", value = 0)
                showModal(modalDialog(
                    title = "",
                    "",
                    easyClose = FALSE,
                    footer = NULL
                ))

                future({
                    progress$set(message = "Calculating current map with Circuitscape...", value = 5)
                    submit_circuitscape(working_dir)
                }) %...>% (function(images) {
                    progress$set(message = "Adding images...", value = 9)
                    logger::log_info("Finished calling circuitscape")
                    l_map <- raster(paste0(working_dir, "/circuitscape/log_current.tif"))
                    miv$add_current(session, l_map)
                    progress$close()
                    disable("generate_curr")
                    removeModal()
                })
            },
            error=function(err) {
                warning(paste('Failed to generate raster :(', err$message))
                showNotification(paste('Failed to generate raster :(', err$message), duration=5, type="error")
            }
        )
    })

    output$download_drawings <- downloadHandler(
        filename <- function() {
            "drawings.zip"
        },
        content <- function(file) {
            logger::log_info(paste("Download reuqired. Zipping files to: ", file))
            shp_dir = paste0(working_dir, "/shape_data")
            drawings$write(shp_dir)
            zip(file, shp_dir, extras = '-j')
        }
    )

    output$download <- downloadHandler(
        filename <- function() {
            "rasters.zip"
        },
        content <- function(file) {
            logger::log_info("Download reuqired. Zipping files...")
            lcurr = paste0(working_dir, "/circuitscape/log_current.tif")
            lres = paste0(working_dir, "/circuitscape/log_resistance.tif")
            lres_png = paste0(working_dir, "/images/log_resistance.png")
            lcurr_png = paste0(working_dir, "/images/log_current.png")

            zip(file, c(lcurr, lres, lres_png, lcurr_png), extras = '-j')
        }
    )
}
