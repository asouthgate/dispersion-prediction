library(raster)
library(logger)

write_pipeline_outputs <- function(resistance_maps, raster_inp, working_dir, disk = NULL) {

    dir.create(file.path(working_dir, "images"), recursive = TRUE, showWarnings = FALSE)

    for (name in c("r_dsm", "r_dtm", "lcm_r")) {
            rast <- raster_inp[[name]]
        if (!is.null(rast) && inherits(rast, "RasterLayer")) {
            fname <- sub("^r_", "", name)
            tif_path <- file.path(working_dir, paste0(fname, ".tif"))
            raster::writeRaster(rast, tif_path, "GTiff", overwrite = TRUE)
        }
    }

    resistance_maps$dsm <- raster_inp$r_dsm
    resistance_maps$dtm <- raster_inp$r_dtm

    logger::log_info("Writing output rasters to GeoTIFF...")
    for (layer_name in names(resistance_maps)) {
        rast <- resistance_maps[[layer_name]]
        if (inherits(rast, "RasterLayer")) {
            out_path <- file.path(working_dir, paste0(layer_name, ".tif"))
            raster::writeRaster(rast, out_path, "GTiff", overwrite = TRUE)
        }
    }

    if (!is.null(resistance_maps$total_res)) {
        log_path <- file.path(working_dir, "log_total_res.tif")
        raster::writeRaster(log(resistance_maps$total_res), log_path, "GTiff", overwrite = TRUE)
    }
    if (!is.null(resistance_maps$lamp_res)) {
        log_path <- file.path(working_dir, "log_lamp_res.tif")
        raster::writeRaster(log(resistance_maps$lamp_res), log_path, "GTiff", overwrite = TRUE)
    }

    if (!is.null(disk) && inherits(disk, "RasterLayer") && !is.null(resistance_maps$total_res)) {
        logger::log_info("Writing clipped total resistance rasters...")

        tr <- resistance_maps$total_res
        tr[is.na(disk)] <- NA
        raster::writeRaster(tr, file.path(working_dir, "total_res_clipped.tif"), "GTiff", overwrite = TRUE)

        ltr <- log(resistance_maps$total_res)
        ltr[is.na(disk)] <- NA
        raster::writeRaster(ltr, file.path(working_dir, "log_total_res_clipped.tif"), "GTiff", overwrite = TRUE)
    }

    n_total <- length(raster::values(resistance_maps$total_res))
    n_valid <- sum(!is.na(raster::values(resistance_maps$total_res)))
    pct <- round(100 * n_valid / n_total, 1)
    logger::log_info("Completed. %d/%d valid pixels (%.1f%%)", n_valid, n_total, pct)
}
