source('r-pkg/R/pipeline.R')

# Load Rdata corresponding to user inputs

args = commandArgs(trailingOnly=TRUE)

load(args[1])

base_inputs <- postprocess_inputs(algorithm_parameters, groundrast, vector_inp, raster_inp, workingDir, lamps, extra_geoms)
logger::log_info("Got base inputs.")
logger::log_info(paste("Saving retrieved base input data to ", paste0(workingDir, "/base_inputs.Rdata")))
save(base_inputs, file=paste0(workingDir, "/base_inputs.Rdata"))
