library(raster)
library(logger)

rasterize_buildings <- function(buildings, groundrast) {

    logger::log_info("Rasterizing buildings")
    if (length(buildings) > 0) {
        buildings_raster <- raster::rasterize(buildings, groundrast)
        buildings_raster[!is.na(buildings_raster)] <- 1
    } else {
        logger::log_info("No buildings")
        buildings_raster <- groundrast
        values(buildings_raster) <- NA
    }
    buildings_raster
}

get_extra_height_rasters <- function(base_raster, geoms, zvals) {
    r <- base_raster
    values(r) <- 0 
    if (length(geoms) < 1) {
        return(r)
    }
    for (gi in 1:length(geoms)) {
        geom <- geoms[gi]
        z <- zvals[[gi]]
        tmp <- raster::rasterize(geom, base_raster, field=z, background=0)
        r <- r + tmp
    }
    return(r)
}

#' Create a raster for the ground, which is 'NA everywhere except roost coordinates'
#'  'used for resampling'.
#'
#' @param x
#' @param y
#' @param radius
#' @param resolution not image resolution, but relative proportion
#' @return raster for ground with roosts
create_ground_rast <- function(x, y, radius, resolution) {
    logger::log_info("Creating ground raster")

    # First ground raster has min and max -inf and inf
    infgroundrast <- raster::raster(
        xmn = x - radius, # set minimum x coordinate
        xmx = x + radius, # set maximum x coordinate
        ymn = y - radius, # set minimum y coordinate
        ymx = y + radius, # set maximum y coordinate
        res = c(resolution, resolution),
        crs = NA
    )
    roosts <- matrix(c(x, y), nrow = 1, ncol = 2)
    # Groundrast now has NA everywhere except roost x, y
    groundrast <- raster::rasterize(roosts, infgroundrast)

    logger::log_info("Created ground raster")
    return(groundrast)
}

#' Create a disk at x, y of a given radius, to be used as a mask
#' 
#' @param groundrast base raster to extract circles from
#' @param x
#' @param y
#' @param radius
#' @return circles raster
create_disk_mask <- function(groundrast, x, y, radius) {

    disk <- groundrast
    raster::values(disk) <- NA

    x <- 0.5 * (disk@extent@xmin + disk@extent@xmax)
    y <- 0.5 * (disk@extent@ymin + disk@extent@ymax)

    disk <- distanceFromPoints(disk, c(x,y))
    disk2 <- disk
    values(disk2) <- (values(disk) < radius)
    values(disk2)[values(disk2) == FALSE] <- NA

    disk2
}

#' Create raster with concentric circles
#' 
#' @param groundrast base raster to extract circles from
#' @param x
#' @param y
#' @param radius
#' @return circles raster
create_circles <- function(groundrast, x, y, radius, n) {

    circles <- groundrast
    raster::values(circles) <- 0
    # TODO: add in an exception if radius is too small
    # TODO: why 50?
    lb <- round(radius / n)
    radii <- seq(lb, radius, lb)
    for (r in seq(lb, radius, lb)) {
        angle <- 2 * pi * (0:(3 * r )) / (3*r)
        df <- data.frame(x=x+r*sin(angle), y=y+r*cos(angle))
        # TODO: change from spatialpoints to spatiallines
points <- sp::SpatialPoints(df, proj4string=sp::CRS(NA_character_), bbox = NULL)
        circles <- circles + raster::rasterize(points, groundrast, background=0)
    }

    # r <- radius
    # angle <- 2 * pi * (0:(3 * r )) / (3*r)
    # df <- data.frame(x=x+r*sin(angle), y=y+r*cos(angle))
    # # TODO: change from spatialpoints to spatiallines
    # points <- sp::SpatialPoints(df, proj4string=CRS(as.character(NA)), bbox = NULL)
    # circles <- circles + raster::rasterize(points, groundrast, background=0)

    circles[circles>0] <- 1
    circles
}



