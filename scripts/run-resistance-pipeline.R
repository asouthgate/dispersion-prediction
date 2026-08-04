source('r-pkg/R/pipeline.R')

# Load Rdata corresponding to user inputs

args <- commandArgs(trailingOnly=TRUE)

load(args[1])

logger::log_info(paste("Run resistance script called with:", args[1]))

resistance_maps <- cal_resistance_rasters(algorithm_parameters, working_dir, base_inputs, save_images=TRUE)
logger::log_info("Got resistance maps.")

logger::log_info(paste("Saving resistance maps to ", paste0(working_dir, "/resistance_maps.Rdata")))
save(resistance_maps, file=paste0(working_dir, "/resistance_maps.Rdata"))


