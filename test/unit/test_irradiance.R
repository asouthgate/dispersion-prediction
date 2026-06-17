options(show.error.locations = TRUE)

library(testthat)

source("R/pipeline.R")
source("R/resistance.R")
source("circuitscape_app/server.R")
source("R/algorithm_parameters.R")

test_that("irradiance is computed as expected.", {

        # Firstly test that some regions that should be blocked off by hard surfaces are
        # Plot to see the setup

        lamps <- data.frame(x=c(1,10), y=c(1,10), z=c(10,5))
        r <- raster::raster(nrows=100, ncols=100, ymn=0, ymx=10, xmn=0, xmx=10)
        soft_surf <- r
        soft_surf[] = 0
        hard_surf <- r
        hard_surf[,50:60] = 20
        hard_surf[50:60,80:90] = 20
        r_dtm <- r
        r_dtm[] = 0
        buildings <- r
        buildings[] = 0

        pi <- cal_lamp_irradiance(lamps, soft_surf, hard_surf, r_dtm, ext)
        expect_equal(sum(pi[75:80,70:80]), 0)
        expect_true(sum(pi[]) > 0)

        # Secondly test soft surface
        lamps <- data.frame(x=c(10), y=c(10), z=c(5))
        soft_surf[] = 0
        hard_surf[] = 0
        hard_surf[,50:60] = 20

        pi <- cal_lamp_irradiance(lamps, soft_surf, hard_surf, r_dtm, ext)

        soft_surf[50:70,] = 10

        pi2 <- cal_lamp_irradiance(lamps, soft_surf, hard_surf, r_dtm, ext)

        # Some parts should be unaffected
        expect_equal(pi[1:5, 90:100], pi2[1:5, 90:100])
        # Shaded parts should have lower total irradiance
        expect_true(sum(pi[90:100,] - pi2[90:100,]) > 0)


})

