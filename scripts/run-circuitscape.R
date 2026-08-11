source('r-pkg/R/rasterfunc.R')
source('r-pkg/R/pipeline.R')

args <- commandArgs(trailingOnly = TRUE)

input_path <- args[1]
working_dir <- dirname(input_path)

logger::log_info("Working dir: %s", working_dir)

logger::log_info("Preparing cs.ini from template")
template_path <- "r-pkg/R/cs.ini.template"
template <- readChar(template_path, file.info(template_path)$size)
ini_content <- gsub("WORKINGDIR", working_dir, template, fixed = TRUE)
ini_path <- file.path(working_dir, "cs.ini")
writeLines(ini_content, ini_path)
logger::log_info("Wrote cs.ini: %s", ini_path)

l_map <- call_circuitscape(working_dir, TRUE)
logger::log_info("Got current map.")

log_current_src  <- file.path(working_dir, "circuitscape", "log_current.tif")
log_current_dest <- file.path(working_dir, "log_current.tif")
if (file.exists(log_current_src)) {
    raster::writeRaster(raster::raster(log_current_src), log_current_dest, "GTiff", overwrite = TRUE)
    logger::log_info("Copied log_current to %s", log_current_dest)
}

current_src  <- file.path(working_dir, "circuitscape", "current.tif")
current_dest <- file.path(working_dir, "current.tif")
if (file.exists(current_src)) {
    raster::writeRaster(raster::raster(current_src), current_dest, "GTiff", overwrite = TRUE)
    logger::log_info("Copied current to %s", current_dest)
}

if (file.exists(input_path) && file.exists(log_current_src)) {
    inputs <- jsonlite::fromJSON(input_path, simplifyVector = FALSE)
    roost_bng <- inputs$roost
    if (!is.null(roost_bng)) {
        resolution <- if (is.null(inputs$params$resolution)) 10 else inputs$params$resolution
        groundrast <- create_ground_rast(roost_bng$easting, roost_bng$northing, roost_bng$radius, resolution)
        disk <- create_disk_mask(groundrast, roost_bng$easting, roost_bng$northing, roost_bng$radius)

        log_current <- raster::raster(log_current_src)
        log_current[is.na(disk)] <- NA
        clipped_path <- file.path(working_dir, "log_current_clipped.tif")
        raster::writeRaster(log_current, clipped_path, "GTiff", overwrite = TRUE)
        logger::log_info("Wrote clipped log_current: %s", clipped_path)
    }
}
