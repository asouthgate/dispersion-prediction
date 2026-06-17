library(R6)
library(leaflet)
library(shiny)
library(shinyBS)
library(raster)

source("R/drawing.R")
source("R/transform.R")
source("R/shapefile_io.R")

#' Remove the UI height param element i
#'
#' @param i and integer index
remove_height_param <- function(i) {
    logger::log_info("Removing height param...")
    shiny::removeUI(selector = paste0("div:has(> #HEIGHT", i, ")"), immediate = TRUE)
}

#' A DrawingCollection widget allowing the user to draw shapes on a map
#'
#' @description This class, when initialized with a session, input, and map reference,
#' will insert UI elements, observers, etc. to allow drawing by the user.
#' This widget is designed to be used within a bsCollapse.
#'
#' The widget maintains a 'selected' drawing; the one that is selected at any time
#' is the one that is modified by the user.
#'
#' @examples
#' dc <- DrawingCollection$new(input, session, leafletProxy("map"))
#' @export
DrawingCollection <- R6Class("DrawingCollection",

    private = list(

        # TODO: enforce limits more sensibly
        MAX_DRAWINGS = 1000,

        # List of drawings
        drawings = list(),

        # Lists of observers; when a drawing is deleted, observers are cleaned up too
        oi_selectors = list(),
        oi_collapses = list(),
        oi_sliders = list(),
        oi_deletors = list(),
        oi_eyes = list(),

        # Map, session, and input references
        map_proxy = NULL,
        session = NULL,
        input = NULL,

        # Counters
        n_created = 0,
        n_drawings = 0,
        selected_i = -1,

        # UI selector, after which the widget elements are inserted
        ui_selector = NULL,

        # TODO: check if this is of any use at all
        # A switch to block the check box observer
        block_check_obs = FALSE,

        #' Create observer for added shape
        create_add_obs = function() {

            o <- shiny::observeEvent(private$input$add_drawing, {
                logger::log_info("Adding drawing...")
                self$create_new_drawing("building")
            })

        },

        #' @description read shapefiles
        #'
        #' @param f folder name
        #' @param layer_name name of layer
        #' @param type type of drawing to create from the data
        #' @param line_mode boolean: if true, create Lines instead of Polygons
        read_shp_file = function(f, layer_name, type, line_mode) {

            spdf <- read_shapefile(f, layer_name)

            if (line_mode) {
                features <- spdf@lines
            } else {
                features <- spdf@polygons
            }

            for (j in seq_along(features)) {

                logger::log_info(paste("Reading polygon", j))

                if (line_mode) {
                    coords <- features[[1]]@Lines[[1]]@coords
                } else {
                    coords <- features[[j]]@Polygons[[1]]@coords
                }

                h <- spdf$heights[[j]]

                di <- self$create_new_drawing(type, h, paste("Imported", type, j))
                logger::log_info(paste("Created new drawing", di))
                xs <- coords[, 1]
                ys <- coords[, 2]
                private$drawings[[as.character(di)]]$set_vals(xs, ys)
            }
        },

        #' Change the type of drawing i to new_type
        change_type = function(i, new_type) {

            logger::log_debug(paste("Changing type...", i, new_type))

            dr <- private$drawings[[as.character(i)]]

            old_xv <- dr$get_clicked_xvals()
            old_yv <- dr$get_clicked_yvals()

            old_height <- dr$height
            old_type <- dr$type


            if (old_type == "lightstring") {
                dr$destroy_spacing_param()
            }

            logger::log_debug(paste("Creating a drawing of new type", new_type))

            remove_height_param(i)

            # delete the old one
            if (new_type == "lightstring") {
                private$drawings[[as.character(i)]] <- LightString$new(i, new_type, old_height)
                private$drawings[[as.character(i)]]$insert_height_param()
                private$drawings[[as.character(i)]]$insert_spacing_param_ui(private$input)
            }
            else if (new_type == "road" || new_type == "river") {
                private$drawings[[as.character(i)]] <- DrawnLine$new(i, new_type, old_height)
            }
            else if (new_type == "lights") {
                private$drawings[[as.character(i)]]$insert_height_param()
                private$drawings[[as.character(i)]] <- DrawnPoints$new(i, new_type, old_height)
            }
            else {
                private$drawings[[as.character(i)]]$insert_height_param()
                private$drawings[[as.character(i)]] <- DrawnPolygon$new(i, new_type, old_height)
            }

            private$add_points(old_xv, old_yv, i)
        },

        #' Add a sequence of points
        add_points = function(xs, ys, j = NULL) {

            logger::log_info("Adding points")

            if (is.null(j)) {
                j <- private$selected_i
            }

            for (i in seq_along(xs)) {
                x <- xs[i]
                y <- ys[i]
                self$add_point_complete(x, y, j)
            }

        },

        #' TODO: unsure where this responsibility should lie
        #' Setup observers for a newly created drawing
        create_observers = function(i) {

            logger::log_info(paste("Creating observers for drawing number", i))

            panelname <- get_panelname(i)
            divname <- get_divname(i)
            selectname <- get_selectname(i)
            buttonname <- get_buttonname(i)
            checkname <- get_checkname(i)
            textname <- get_textname(i)
            eyename <- get_eyename(i)

            # Create type selector
            private$oi_selectors[[i]] <- shiny::observeEvent(private$input[[selectname]], {
                new_type <- gsub(" ", "", tolower(private$input[[selectname]]), fixed=TRUE)
                logger::log_info(paste("Selector triggered for drawing with new type", new_type))
                dr <- private$drawings[[as.character(i)]]
                dr$clear_graphics(private$map_proxy)
                private$change_type(i, new_type)
            }, ignoreInit = TRUE)

            logger::log_info("Created selector...")

            # Create check box selection
            private$oi_collapses[[i]] <- shiny::observeEvent(private$input[[checkname]], {
                logger::log_info(paste("Check triggered for drawing", i))

                if (private$block_check_obs) {
                    logger::log_info(paste("Blocking check observer", i))
                    # private$block_check_obs <- FALSE
                    return()
                }

                if (private$input[[checkname]]) {
                    logger::log_info(paste("Check triggered with input state", private$input[[checkname]]))
                    self$select(i)
                    # private$selected_i <- i
                } else {
                    self$unselect_no_ui_update(i)
                }
            }, ignoreInit = TRUE)

            logger::log_info("Created Check...")

            # Create height slider observer; may be removed again
            private$oi_sliders[[i]] <- shiny::observeEvent(private$input[[paste0("HEIGHT", i)]], {
                private$drawings[[as.character(i)]]$height <- as.double(private$input[[paste0("HEIGHT", i)]])
            })

            logger::log_info("Created slider...")

            # Create drawing deletion button observer
            private$oi_deletors[[i]] <- shiny::observeEvent(private$input[[buttonname]], {
                self$delete(i)
            }, ignoreInit = TRUE, once = TRUE)

            logger::log_info("Created delete button...")

            # Create eye observer to hide drawings
            private$oi_eyes[[i]] <- shiny::observeEvent(private$input[[eyename]], {
                logger::log_info("Triggering eye observer...")
                private$drawings[[as.character(i)]]$set_visibility(private$map_proxy, private$input[[eyename]])
            }, ignoreInit = TRUE)

            logger::log_info("Created eye button...")

        },

        #' @description get lines
        #' @param type building type
        #' @param use_invisible bool, if FALSE, ignore those that are invisible
        get_lines = function(type, use_invisible=FALSE) {
            logger::log_info("Creating lines...")

            heights <- c()
            lines <- list()

            for (d in private$drawings) {

                if (d$type == type) {
                    if (d$visible || use_invisible) {
                        lines <- append(lines, d$get_shape())
                        heights <- c(heights, d$height)
                    }
                }
            }

            x <- length(lines)

            if (x == 0) {
                return(NULL)
            }

            d <- data.frame(row.names = c(type), id = 1)
            lines <- sp::Lines(lines, type)
            logger::log_info("Creating SpatialLines")
            splines <- sp::SpatialLines(list(lines))
            spd <- sp::SpatialLinesDataFrame(splines, data = d)
            terra::crs(spd) <- sp::CRS("+init=epsg:4326")
            return(spd)

        },

        uncheck_box = function(k) {
            logger::log_info(paste("Unchecking box", k))
            updateCheckboxInput(private$session, get_checkname(k), value = 0)
        }
    ),

    public = list(

        #' @description create a DrawingCollection
        #'
        #' @param input shiny input
        #' @param session shiny session
        #' @param map leaflet proxy
        #' @param ui_selector selector for placement
        initialize = function(input, session, map, ui_selector = "#drawing_collection_ui") {

            logger::log_info("Initializing drawing collection...")

            private$ui_selector <- ui_selector
            private$map_proxy <- map
            private$session <- session
            private$input <- input

            private$create_add_obs()

        },

        #' @description get list of drawings
        get_drawings = function() {
            return(private$drawings)
        },

        #' @description select drawing i
        #'
        #' @param i integer id for a drawing
        select = function(i) {
            logger::log_info(paste("Selecting", i))
            private$block_check_obs <- TRUE
            self$unselect()
            private$selected_i <- i
            shiny::updateCheckboxInput(private$session, get_checkname(i), value = 1)
            private$block_check_obs <- FALSE
        },

        #' @description delete drawing i
        #'
        #' @param integer index i
        delete = function(i) {

            if (!(as.character(i) %in% names(private$drawings))) {
                logger::log_info("Trying to delete a drawing that doesn't exist, returning")
                return()
            }

            logger::log_info("Deleting object")

            private$n_drawings <- private$n_drawings - 1

            divname <- get_divname(i)
            shiny::removeUI(selector = paste0("#", divname))

            private$drawings[[as.character(i)]]$clear_graphics(private$map_proxy)
            private$drawings[[as.character(i)]] <- NULL

            if (is.null(private$selected_i) || private$selected_i == i) {
                private$selected_i <- NULL
            }

            private$oi_selectors[[i]]$destroy()
            private$oi_collapses[[i]]$destroy()
            private$oi_sliders[[i]]$destroy()
            private$oi_deletors[[i]]$destroy()
            private$oi_eyes[[i]]$destroy()

            if (private$n_drawings < private$MAX_DRAWINGS) {
                shinyjs::enable("add_drawing")
            }
        },

        #' @description write shapefiles
        #'
        #' @param shp_dir string directory name
        write = function(shp_dir) {

            spatial_dfs <- self$get_spatial_dfs()

            buildings <- spatial_dfs$buildings
            roads <- spatial_dfs$roads
            rivers <- spatial_dfs$rivers
            lights <- spatial_dfs$lights

            dir.create(shp_dir)

            if (!is.null(buildings)) {
                logger::log_info(paste("Writing buildings to", shp_dir))
                write_shapefile(buildings, shp_dir, "buildings")
            }
            if (!is.null(roads)) {
                write_shapefile(roads, shp_dir, "roads")
            }
            if (!is.null(rivers)) {
                write_shapefile(rivers, shp_dir, "rivers")
            }
            if (nrow(lights) > 0) {
                write.csv(lights, paste0(shp_dir, "/lights.csv"))
            }

        },

        #' @description read buildings from a file
        #' 
        #' @param f folder with shape files
        read_buildings = function(f) {
            logger::log_info("Reading buildings")
            private$read_shp_file(f, "buildings", "building", FALSE)
        },

        #' @description read roads from a file
        #'
        #' @param f folder with shape files
        read_roads = function(f) {
            logger::log_info("Reading roads")
            private$read_shp_file(f, "roads", "road", TRUE)
        },

        #' @description read rivers from a file
        #'
        #' @param f folder with shape files
        read_rivers = function(f) {
            logger::log_info("Reading rivers")
            private$read_shp_file(f, "rivers", "river", TRUE)
        },

        #' @description read lights
        #'
        #' @param f csv file
        read_lights = function(f) {

            logger::log_info("Reading lights")
            df <- read.csv(f)
            xs <- df$x
            ys <- df$y
            h <- df$z[1]

            di <- self$create_new_drawing("lights", h, label="lights")
            private$drawings[[as.character(di)]]$set_vals(xs, ys)

        },

        #' @description get buildings
        #' @param use_invisible bool, if FALSE, ignore those that are invisible
        #' @returns SpatialPolygonsDataFrame 
        get_buildings = function(use_invisible = FALSE) {

            logger::log_debug("Getting buildings...")

            heights <- c()
            building_polygons <- list()

            bi <- 1

            for (d in private$drawings) {

                if (d$type == "building" && d$n >= 4) {
                    if (d$visible || use_invisible) {
                        shape <- list(d$get_shape())
                        logger::log_debug("Creating a polygon...")
                        polygon <- sp::Polygons(shape, paste0("b", bi))
                        logger::log_debug("Appending...")
                        building_polygons <- append(building_polygons, polygon)
                        logger::log_debug("Appending to heights")
                        heights <- c(heights, d$height)
                        bi <- bi + 1
                    }
                }

            }

            x <- length(building_polygons)

            if (x == 0) {
                return(NULL)
            }

            rownames <- paste0("b", 1:(bi-1))

            d <- data.frame(row.names = rownames, heights=heights)

            logger::log_debug("Creating spatial polygons data frame...")
            spd <- sp::SpatialPolygonsDataFrame(sp::SpatialPolygons(building_polygons), data = d)
            logger::log_debug("Setting CRS...")
            terra::crs(spd) <- sp::CRS("+init=epsg:4326")
            return(spd)

        },

        #' @description get roads
        #' @returns SpatialLinesDataFrame
        get_roads = function() {
            logger::log_debug("Getting roads...")
            return(private$get_lines("road"))
        },

        #' @description get rivers
        #' @returns SpatialLinesDataFrame
        get_rivers = function() {
            logger::log_debug("Getting rivers...")
            return(private$get_lines("river"))
        },

        #' @description get lights
        #' @returns lights dataframe
        get_lights = function(use_invisible=FALSE) {

            logger::log_debug("Getting lights.")

            dfs <- list()

            for (d in private$drawings) {

                if (d$type == "lights" || d$type == "lightstring") {
                    if (d$visible || use_invisible) {
                        ldf <- d$get_shape()
                        print(ldf)
                        dfs <- append(dfs, list(ldf))
                    }
                }
            }

            if (length(dfs) == 0) {
                return(data.frame(x=c(), y=c(), z=c()))
            }

            lightsdf <- do.call(rbind, dfs)

            return(lightsdf)

        },

        #' @description retrieve spatial data associated with all drawings for use downstream
        #' @param crs an integer CRS (optional)
        #' @returns list of (Spatial) dataframes for each type of drawing
        get_spatial_dfs = function(crs = NULL) {

            logger::log_debug("Getting spatial data from drawings.")

            result <- list(buildings = self$get_buildings(), roads = self$get_roads(),
                        rivers = self$get_rivers(), lights = self$get_lights())

            if (!is.null(crs)) {
                logger::log_debug("Transforming spatial data frames.")
                crstring <- paste0("+init=epsg:", crs)
                if (!is.null(result$buildings)) {
                    logger::log_debug("Transforming buildings...")
                    result$buildings <- sp::spTransform(result$buildings, crstring)
                }
                if (!is.null(result$rivers)) {
                    logger::log_debug("Transforming rivers...")
                    result$rivers <- sp::spTransform(result$rivers, crstring)
                }
                if (!is.null(result$roads)) {
                    result$roads <- sp::spTransform(result$roads, crstring)
                }
                if (nrow(result$lights) > 0) {
                    logger::log_info("Transforming lights")
                    result$lights <- vector_convert_points(result$lights, 4326, crs)
                }
            }

            return(result)
        },

        #' @description Append a point to a drawing if it is not already marked complete or is not null
        #' @param x x coordinate
        #' @param y y coordinate
        #' @param j optional integer index for the shape to add vector (x, y) to
        add_point_complete = function(x, y, j=NULL) {

            if (is.null(j)) {
                j <- private$selected_i
            }

            if (is.null(j) || private$drawings[[as.character(j)]]$is_complete) {
                return()
            }

            if (!private$drawings[[as.character(j)]]$visible) {
                return()
            }

            private$drawings[[as.character(j)]]$append_click_history(x, y)
            private$drawings[[as.character(j)]]$append(private$map_proxy, x, y)

        },

        #' @description check if something is selected
        something_is_selected = function() {
            logger::log_info(paste("Something is selected", private$selected_i))
            if (is.null(private$selected_i)) {
                return(FALSE)
            }
            if (private$selected_i > 0) {
                return(TRUE)
            }
            return(FALSE)
        },

        #' @description unselect currently selected drawing
        unselect = function() {
            logger::log_info(paste("Unselecting", private$selected_i))
            if (!is.null(private$selected_i)) {
                logger::log_info(paste("Unchecking box and setting to null"))
                private$uncheck_box(private$selected_i)
                private$selected_i <- NULL
            } else {
                logger::log_info(paste("Unselect did nothing"))
            }
            logger::log_info(paste("Selected is now", private$selected_i))
        },

        #' @description unselect drawing k but do not trigger UI update
        #' @param k integer drawing ID
        unselect_no_ui_update = function(k) {
            logger::log_info("Unselecting but not updating ui")
            # Only act if k is currently selected
            if (is.null(private$selected_i)) {
                logger::log_info("Nothing is currently selected")
                return()
            }
            if (private$selected_i != k) {
                logger::log_info(paste(k, "is not currently selected"))
                return()
            }
            private$selected_i <- NULL
        },

        # TODO: replace string types with enums
        #' @description create a new drawing
        #' @param type string type of drawing
        #' @param height
        #' @param label
        create_new_drawing = function(type, height = 10, label = NULL) {

            logger::log_info("Attempting to create a new object")
            if (private$n_drawings < private$MAX_DRAWINGS) {

                private$n_created <- private$n_created + 1
                private$n_drawings <- private$n_drawings + 1

                di <- private$n_created

                if (type == "building") {
                    dr <- DrawnPolygon$new(di, "building", height)
                    ui_el <- dr$create_ui_element("Building", label)
                } else if (type == "river") {
                    dr <- DrawnLine$new(di, "river")
                    ui_el <- dr$create_ui_element("River", label)
                } else if (type == "road") {
                    dr <- DrawnLine$new(di, "road")
                    ui_el <- dr$create_ui_element("Road", label)
                } else if (type == "lightstring") {
                    dr <- LightString$new(di, "lightstring", height)
                    ui_el <- dr$create_ui_element("Light String", label)
                } else if (type == "lights_var_heights") {
                    dr <- DrawnPointsVariableHeights$new(di, "lights", height)
                    ui_el <- dr$create_ui_element("Lights", label)
                } else {
                    dr <- DrawnPoints$new(di, "lights", height)
                    ui_el <- dr$create_ui_element("Lights", label)
                }

                private$drawings[[as.character(di)]] <- dr

                if (!(type == "road" || type == "river" || type == "lights_var_heights")) {
                    dr$insert_height_param()
                }

                if (type == "lightstring") {
                    dr$insert_spacing_param_ui()
                }

                private$create_observers(di)

                if (private$n_drawings == private$MAX_DRAWINGS) {
                    disable("add_drawing")
                }

                return(di)
            }

        }
    )
)
