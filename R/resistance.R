library(raster)
library(logger)

source("R/irradiance.R")

#' Get a function that takes x, y, and returns value if y is 1, otherwise x
#'
#' @param value value to set 1s to
#' @return function f
filter_binary_layer <- function(value) {
    fn <- function(x, y) {
        ifelse(y==1, value, x)
    }
    return(fn)
}

#' Rasterize some data, and for any NAs, take the distance to the nearest non-NA
#' 
#' @param data spatial dataframe
#' @param groundrast base raster to use
#' @return distance a distance raster 
cal_distance_raster <- function(data, groundrast) {
    r <- raster::rasterize(data, groundrast)
    v <- raster::values(r)
    if (length(v[is.na(v)]) == 0) {
        logger::log_error("Cannot calculate a distance raster on data without any NA values. This probably should not have happened. Do the vector features cover every pixel?")
        stop("Cannot call raster::distance on data without NAs")
    }
    distance <- raster::distance(r)
    return(distance)
}

#' Calculate a resistance map for roads
#' 
#' Roads repel bats and provide resistance; the minimum is zero, when no roads are around. 
#'
#' @param roads vector data frame 
#' @param groundrast
#' @param buffer meters to river
#' @param resmax maximum resistance of "layers"
#' @param xmax "slope value"
#' @return raster::raster object for roads
cal_road_resistance <- function(roads, groundrast, buffer, resmax, xmax) {

    if (length(roads)  == 0) {
        logger::log_warn("No road data in study area -- road resistance will be zero everywhere")
        resistance <- groundrast
        raster::values(resistance) <- 0
        terra::crs(resistance) <- terra::crs(groundrast)
        return(resistance)
    }

    road_distance <- cal_distance_raster(roads, groundrast)

    resistance <- calc(road_distance,
        function(d) {
            ifelse(d > buffer, 0, ( ((1 - (d/buffer))*0.5 + 0.5) ^ xmax) * resmax)
        }
    )

    return(resistance)
}

#' Calculate a resistance map for rivers
#'
#' Rivers are the opposite to roads; they provide conductance.
#
#' @param river sp-class (SpatialPoints*, SpatialMultiPoints*, SpatialLines*, or SpatialPolygons*)
#' @param groundrast
#' @param buffer meters to river
#' @param resmax maximum resistance of "layers"
#' @param xmax "slope value"
#' @return raster::raster object for rivers
cal_river_resistance <- function(river, groundrast, buffer, resmax, xmax) {

    rbuff <- resmax

    if (length(river)  == 0) {
        logger::log_warn("No river data in study area -- river resistance will be max everywhere")
        resistance <- groundrast
        raster::values(resistance) <- rbuff
        return(resistance)
    }

    river_distance <- cal_distance_raster(river, groundrast)

    # in the actual river, no resistance
    river_distance[is.na(river_distance)] <- 0

    # TODO: why + 1?
    resistance <- calc(river_distance,
                            function(d) {
                                # TODO: move to a separate function, since reused
                                # TODO: reference does not use a power
                                # ifelse(d > buffer, rbuff, ((d/buffer)^xmax)*resmax)
                                ifelse(d > buffer, rbuff, ((d/buffer) ^ xmax) * resmax)
                            }
                        )

    # TODO: why is there a resistance of 1 in the river?
    resistance[is.na(resistance)] <- 0

    return(resistance)
}

#' Calculate a resistance map given distance rasters for features
#'
#' @param buffer distance from features
#' @param rankmax
#' @param rbuff
#' @param resmax
#' @param xmx
#' @param distance_rasters
#' @param effect can be "negative" or something else
#' @return resistance raster
distance2resistance <- function(buffer, rankmax, resmax, xmax, distance_rasters) {

    logger::log_info("Calculating resistance from distance")
    
    raster_resistance <- distance_rasters[[1, 1]]
    raster::values(raster_resistance) <- 0
    
    # Loop over the distance rasters and, using their ranking, calculate contributions to resistance
    for (i in nrow(distance_rasters)) {

        rast <- distance_rasters[[i, 1]]
        Ranking <- distance_rasters[[i, 2]]

        # TODO: the examples provide resmax as the rbuff, but this means there is a discontinuity at d/buffer = 1
        #       also the resistance outside max distance is the same for all ranks
        rbuff <- (( (0.5 + 0.5 * (Ranking/rankmax))^ xmax) * resmax) + 1
        # rbuff <- resmax

        rast[is.na(rast) == TRUE] <- 0
        # partial_resistance <- round(raster::calc(rast, function(d) {ifelse(d > buffer, rbuff, (((0.5 * (d/buffer) + 0.5 * (Ranking/rankmax))^ xmax) * resmax))}) + 1, digits=3) 
        partial_resistance <- raster::calc(rast, function(d) {ifelse(d > buffer, rbuff, (((0.5 * (d/buffer) + 0.5 * (Ranking/rankmax))^ xmax) * resmax))}) + 1 

        raster_resistance <- raster::overlay(partial_resistance, raster_resistance, fun = max)

    }
    raster_resistance[is.na(raster_resistance) == TRUE] <- 1
    raster_resistance
}

cal_distance_with_defaults <- function(rast, max_d=999999999999) {
    logger::log_info("Calculating distance for feature raster (hedges, uhedges, trees)")

    rdist <- rast
    
    if (!(NA %in% rast@data@values)) {
        # everything is a hedge
        logger::log_warn("Surface is only hedges")
        raster::values(rdist) <- 0

    } else if (!(1 %in% rast@data@values)) {
        # no hedges, everything max distance
        logger::log_warn("Surface contains no hedges")
        raster::values(rdist) <- max_d

    } else {
        # some hedges, can cal dist
        rast <- raster::buffer(rast, width=10)
        rdist <- raster::distance(rast)
    }

    rdist
}

#' Generate new distance rasters
#'
#' @param surf a raster representing the surface
#' @return distance_rasters a matrix of distance rasters
prep_lidar_rasters <- function(surf) {
    logger::log_info("Preparing lidar rasters (extracting features")
    # TODO: seems to assume that surface map is either managed hedge, umanaged, or tree? How do we know only those 3?
    # Generates new rasters containing locations of:
    # - manhedge.asc: managed hedgerows (height = 1m-3m above ground)
    # - unmanhedge.asc: unmanaged hedgerows (height = 3m-6m above ground)
    # - tree.asc: trees (height = 6m+ above ground)
    # Add a buffer around all features of width 10m
    # Then calculate the distance in each cell to the nearest feature
    # Distance raster files are saved in directory output_dir

    manhedge <- surf
    manhedge[surf<3 & surf>1] <- 1
    manhedge[surf>=3] <- NA
    manhedge[surf<=1] <- NA
    mh_dist <- cal_distance_with_defaults(manhedge)

    unmanhedge <- surf
    unmanhedge[surf<6 & surf>3] <- 1
    unmanhedge[surf>=6] <- NA
    unmanhedge[surf<=3] <- NA
    umh_dist <- cal_distance_with_defaults(unmanhedge)

    tree <- surf
    tree[surf>=6] <- 1
    tree[surf<6] <- NA
    tree_dist <- cal_distance_with_defaults(tree)

    distance_rasters <- matrix(c(umh_dist, tree_dist, mh_dist, 1, 2, 4), nrow=3, ncol=2)
    return(list(manhedge=manhedge, unmanhedge=unmanhedge, tree=tree, distance_rasters=distance_rasters))
}

#' Given dtm, dsm and building rasters, calculate 'hard' and 'soft' surfaces
#'
#' Hard and soft surfaces are height maps, with 'hard' surfaces being buildings,
#' and 'soft' surfaces being 
calc_surfs <- function(dtm, dsm, buildings) {
    # Returns surf, soft and hard surface rasters
    logger::log_info("getting surf from dsm/dtm")
    surf <- dsm - dtm

    logger::log_info("getting soft surf")
    soft_surf <- surf
    soft_surf[!is.na(buildings)] <- 0
    # soft_surf <- surf - soft_surf

    logger::log_info("getting hard surf")
    hard_surf <- buildings
    hard_surf[is.na(hard_surf)] <- 0
    hard_surf <- hard_surf * surf
    # hard_surf <- abs(hard_surf - surf)

    return(c("surf"=surf, "soft_surf"=soft_surf, "hard_surf"=hard_surf))
}

#' Calculate resistance from conductance map with ranks
ranked_resistance <- function(conductance, rankmax, resmax, xmax) {
    resistance <- raster::calc(conductance, fun=function(rank) {ifelse(rank == rankmax, resmax, ((rank/rankmax) ^ xmax) * resmax)})
    resistance[is.na(resistance) == TRUE] <- 0
    return(resistance)
}

#' Generate landscape resistance from lcm
#'
#' Again, certain landscape features are preferred by bats.
#' Resistance is determined by rankings.
#' Resistance in interval [0, resmax]
#' 
#' @param lcm landscape cover map, gives the type of surface
#' @param buildings buildings raster
#' @param soft_surf 
#' @returns resistance raster
get_landscape_resistance_lcm <- function(lcm, buildings, soft_surf, rankmax, resmax, xmax) {

    logger::log_info("Getting landscape resistance")

    # TODO: should be able to put this in as input parameters
    # Firstly calculate rankings
    lidar_ranking <- c(-Inf, 0.5, 4,  # grass
                        0.5, 2.5, 3,  # scrub
                        2.5, Inf, 3)  # trees

    # Set soft surface NAs to zero
    soft_surf[is.na(soft_surf)] <- 0
    conductance <- raster::reclassify(soft_surf, lidar_ranking) + lcm
    max_value <- raster::maxValue(conductance) + 1
    
    # Create a raster bitmask for buildings
    brast <- buildings
    brast[!is.na(brast==TRUE)] <- 1.0 
    brast[is.na(brast==TRUE)] <- 0.0 

    # If there are buildings, set to max rank value
    conductance <- raster::overlay(conductance, brast, fun=filter_binary_layer(max_value))
    resistance <- ranked_resistance(conductance, rankmax, resmax, xmax)

    resistance
}

#' Calculate a linear resistance map
#'
#' Bats like linear features, such as hedgerows; low resistance near the features.
#' Values in interval [1, resmax]
#'
#' @param drasts
#' @param buffer
#' @param rankmax
#' @param resmax
#' @param xmax
#' @return resistance: raster::raster object
get_linear_resistance <- function(drasts, buffer, rankmax, resmax, xmax) {

    logger::log_info("Calculating linear resistance (conductance)")

    resistance <- distance2resistance(buffer, rankmax, resmax, xmax, drasts)
    resistance[is.na(resistance) == TRUE] <- 1

    resistance
}

#' Calculate light resistance from an irradiance raster
light_resistance <- function(resmax, xmax, irradiance_raster) {
    logger::log_info("Calculating light resistance from irradiance")
    irradiance_raster[is.na(irradiance_raster==TRUE)] <- 0
    maxpi <- maxValue(irradiance_raster)
    # raster_resistance <- round(calc(rast, fun=function(PI) {((PI/MaxPI)^xmax) * resmax}) + 1, digits = 5)
    raster_resistance <- calc(irradiance_raster, fun=function(p) {((p/maxpi)^xmax) * resmax})
    raster_resistance[is.na(raster_resistance) == TRUE] <- 0
    # writeRaster(raster_resistance, filename=outputfile, NAflag=-9999, overwrite=TRUE)
    raster_resistance
}

#' Calculate point irradiance for lamps
#'
#' Resistance values in [1, resmax]
#'
#' @param lamps lamp raster
#' @param soft_surf soft surface raster
#' @param hard_surf hard surface raster
#' @param dtm lidar digital terrain map
#' @param ext extent (boundary)
#' @param resmax
#' @param xmax
#' @return resistance raster
cal_lamp_irradiance <- function(lamps, soft_surf, hard_surf, dtm, ext) {

    logger::log_info("Calculating the irradiance from lamps")

    if (nrow(lamps)==0) {
        logger::log_info("No lamps found.")
        resistance <- soft_surf
        raster::values(resistance) <- 0
        return(resistance)
    }

    pixw <- raster::res(dtm)[1]
    point_irradiance <- wrap_cal_irradiance(lamps, soft_surf, hard_surf, dtm, pixw=pixw, cutoff=ext)
    point_irradiance
}

