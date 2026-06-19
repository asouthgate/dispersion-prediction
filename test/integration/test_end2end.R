options(show.error.locations = TRUE)

library(testthat)

source("R/pipeline.R")
source("circuitscape_app/server.R")
source("R/algorithm_parameters.R")

test_that("Test that resistance pipeline with standard data comes out as expected.", {

    local({
        # Here, we override the function that raises the error
        suppressWarnings({

            load('./test/base_inputs.Rdata')

            workingDir <- './test/tmp/'

            csdir <- paste0(workingDir, "/circuitscape")

            dir.create(csdir)

            res <- cal_resistance_rasters(algorithm_parameters, "./test/tmp", base_inputs, save_images=TRUE)

            load('./test/resistance_maps.Rdata')

            # load('./test/test_input_data.Rdata')
            non_na_total_res <- res$total_res[!is.na(res$total_res)]
            non_na_total_res2 <- resistance_maps$total_res[!is.na(resistance_maps$total_res)]
            expect_equal(res$total_res[], resistance_maps$total_res[])
            expect_equal(res$linear_res[], resistance_maps$linear_res[])
            expect_equal(res$lampRes[], resistance_maps$lampRes[])


        })
    })


})
