#!/usr/bin/env Rscript
#
# Shared plot script — writes clean colormap image overlays.
# One source of truth for all PNG generation.
#
# Usage:
#   Rscript test/plot_outputs.R <work_dir>

library(raster)
library(logger)
library(png)

plot_directory <- function(working_dir) {
    img_dir <- file.path(working_dir, "images")
    dir.create(img_dir, recursive = TRUE, showWarnings = FALSE)
    logger::log_info("Plotting overlays in %s", img_dir)

    tif_files <- list.files(working_dir, pattern = "\\.tif$", full.names = TRUE)
    if (length(tif_files) == 0) {
        logger::log_warn("No TIF files found in %s", working_dir)
        return(invisible())
    }

    for (tif_path in tif_files) {
        layer_name <- tools::file_path_sans_ext(basename(tif_path))
        savepath <- file.path(img_dir, paste0(layer_name, ".png"))

        tryCatch({
            rast <- raster::raster(tif_path)
            vals <- as.vector(raster::values(rast))
            nona <- is.finite(vals)
            if (sum(nona) == 0) next

            vmin <- min(vals[nona])
            vmax <- max(vals[nona])
            if (vmax == vmin) vmax <- vmin + 1

            idx <- floor((vals - vmin) / (vmax - vmin) * 254) + 1
            idx[!nona] <- NA_integer_

            col_rgb <- col2rgb(terrain.colors(255)) / 255

            rgba <- array(0, dim = c(nrow(rast), ncol(rast), 4))
            ncells <- nrow(rast) * ncol(rast)
            for (b in 1:3) {
                layer <- numeric(ncells)
                layer[nona] <- col_rgb[b, idx[nona]]
                rgba[,,b] <- matrix(layer, nrow(rast), ncol(rast), byrow = TRUE)
            }
            rgba[,,4] <- matrix(as.numeric(nona), nrow(rast), ncol(rast), byrow = TRUE)

            writePNG(rgba, savepath)
        }, error = function(err) {
            logger::log_warn(paste("Failed to plot", layer_name, ":", err$message))
        })
    }

    logger::log_info("Plotted %d overlays.", length(tif_files))
    invisible()
}

if (!interactive() && length(commandArgs(trailingOnly = TRUE)) >= 1) {
    args <- commandArgs(trailingOnly = TRUE)
    plot_directory(args[1])
}
