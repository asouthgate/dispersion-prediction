library(R6)
library(sp)

#' Create an extent given algorithm parameters with roost location
#'  and radius (side length)
#'
#' @param x
#' @param y
#' @param delta side length of the bounding box
#' @return raster::extent object
create_extent <- function(x, y, delta) {

    xmin <- x - delta
    xmax <- x + delta
    ymin <- y - delta
    ymax <- y + delta

    raster::extent(xmin, xmax, ymin, ymax)
}

vector_convert_points <- function(df, old, new) {
    logger::log_debug("Converting points...")
    coordsdf <- data.frame(newx=df$x, newy=df$y)
    old_crs <- sp::CRS(sf::st_crs(as.integer(old))$proj4string)
    new_crs <- sp::CRS(sf::st_crs(as.integer(new))$proj4string)
    spdf <- SpatialPointsDataFrame(data=df, coords=coordsdf, proj4string=old_crs)
    spdf2 <- as.data.frame(as(sf::st_transform(sf::st_as_sf(spdf), sf::st_crs(as.integer(new))), "Spatial"))
    ret <- df
    ret$x <- spdf2$newx
    ret$y <- spdf2$newy
    logger::log_debug("Converted points")
    return(ret)
}

#' Get approximate metres length for a dlat, dlon, works on small scales
#' 
#' @param dlat
#' @param dlon
approx_metres <- function(dlat, dlon) {
    dlat <- abs(dlat)
    dlon <- abs(dlon)
    x <- dlat
    y <- (dlon) * cos((dlat) * 0.00872664626)
    return(1000 * 111.319 * sqrt(x*x + y*y))
}

# #' Draw line markers on a map with dots
# #' 
# #' @param map
# #' @param xvals
# #' @param yvals
# #' @param color
# #' @param dot_radius
# #' @param circle_layer_id
# #' @param line_layer_id
# draw_line_on_map <- function(map, xvals, yvals, color, line_layer_id) {
#     n <- length(xvals)
#     addPolylines(map, data=cbind(xvals, yvals), weight=2, color=color, fillColor = color, opacity = 1, layerId=line_layer_id)
# }

# #' Draw dot markers on a map
# #' 
# #' @param map
# #' @param xvals
# #' @param yvals
# #' @param color
# #' @param dot_radius
# #' @param circle_layer_id
# draw_dots_on_map <- function(map, xvals, yvals, color, circle_layer_id, dot_radius=5) {
#     n <- length(xvals)
#     addCircles(map, lng=xvals[n], lat=yvals[n], weight=1, radius=dot_radius, fillOpacity=1, color = color, opacity=1, group=circle_layer_id)
# }