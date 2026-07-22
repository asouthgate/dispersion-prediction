library(R6)

#
# R6 Classes to represent the parameters of the bat dispersion algorithm.
# Objects of these classes are populated by values collected from the
# corresponding parts of the user interface. Generally, parameters are:initialize
#
# Resmax: max resistance for layer
# buffer: a zone around some object
# xmax: a slope value for resistance that changes with distance
# rankmax: some kind of value that corresponds to maximum rank,
#   since some resistance layers have discrete set of ranks that they use


#' @title R6 class representing a roost location
#'
#' @description Wrapper for roost easting, northing, and radius
#'
#' @export
#' @importFrom R6 R6Class
Roost <- R6Class(
    "Roost",
    public=list(
        x = 0,
        y = 0,
        radius = 0,
        initialize = function(x, y, radius) {
            self$x <- x
            self$y <- y
            self$radius <- radius
        }
    )
)

#' @title R6 class representing road parameters for resistance map generation
#'
#' @description Wrapper for buffer, resmax, xmax
#'
#' @export
#' @importFrom R6 R6Class
RoadResistance <- R6Class(
    "RoadResistance",
    public=list(
        buffer = 0,
        resmax = 0,
        xmax = 0,
        initialize = function(buffer, resmax, xmax) {
            self$buffer <- buffer
            self$resmax <- resmax
            self$xmax <- xmax
        }
    )
)

# TODO: duplication here; it is exactly the same as RoadResistance; a GenericResistance would be better
# TODO: actually, just a list of (key, val) would be better
#' @title R6 class representing river parameters for resistance map generation
#'
#' @description Wrapper for buffer, resmax, xmax
#'
#' @export
#' @importFrom R6 R6Class
RiverResistance <- R6Class(
    "RiverResistance",
    public=list(
        buffer = 0,
        resmax = 0,
        xmax = 0,
        initialize = function(buffer, resmax, xmax) {
            self$buffer <- buffer
            self$resmax <- resmax
            self$xmax <- xmax
        }
    )
)

#' @title R6 class representing landscape parameters for resistance map generation
#'
#' @description Wrapper for resmax, xmax
#'
#' @export
#' @importFrom R6 R6Class
LandscapeResistance <- R6Class(
    "LandscapeResistance",
    public=list(
        resmax = 0,
        xmax = 0,
        rankmax = 11,
        initialize = function(rankmax, resmax, xmax) {
            self$resmax <- resmax
            self$xmax <- xmax
            self$rankmax <- rankmax
        }
    )
)

#' @title R6 class representing linear parameters for resistance map generation
#'
#' @description Wrapper for buffer, resmax, rankmax, xmax
#'
#' @export
#' @importFrom R6 R6Class
LinearResistance <- R6Class(
    "LinearResistance",
    public=list(
        buffer = 0,
        resmax = 0,
        rankmax = 0,
        xmax = 0,
        initialize = function(buffer, resmax, rankmax, xmax) {
            self$buffer <- buffer
            self$resmax <- resmax
            self$rankmax <- rankmax
            self$xmax <- xmax
        }
    )
)

#' @title R6 class representing lamp parameters for resistance map generation
#'
#' @description Wrapper for buffer, resmax, rankmax, xmax
#'
#' @export
#' @importFrom R6 R6Class
LampResistance <- R6Class(
    "LampResistance",
    public=list(
        resmax = 0,
        xmax = 0,
        ext = 0,
        initialize = function(resmax, xmax, ext) {
            self$resmax <- resmax
            self$xmax <- xmax
            self$ext <- ext
        }
    )
)

#' @title R6 class wrapping parameter classes together
#'
#' @description Wraps roost parameters, parameters for each resistance layer, resolution, etc.
#'
#' @export
#' @importFrom R6 R6Class
AlgorithmParameters <- R6Class(
    "AlgorithmParameters",
    public=list(
        roost = NULL,
        roadResistance = NULL,
        riverResistance = NULL,
        landscapeResistance = NULL,
        linearResistance = NULL,
        lampResistance = NULL,
        resolution = 1,
        extent = NULL,
        n_circles = 1,
        initialize = function(roost, roadResistance=NULL, riverResistance=NULL, landscapeResistance=NULL, 
                            linearResistance=NULL, lampResistance=NULL, resolution=1, n_circles=1) {
            self$roost <- roost
            self$roadResistance <- roadResistance
            self$riverResistance <- riverResistance
            self$landscapeResistance <- landscapeResistance
            self$linearResistance <- linearResistance
            self$lampResistance <- lampResistance
            self$resolution <- resolution
            self$n_circles <- n_circles
        }
    )
)