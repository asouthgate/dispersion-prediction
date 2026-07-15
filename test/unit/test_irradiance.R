options(show.error.locations = TRUE)

library(testthat)
library(raster)
library(sp)

setwd(getOption("project_root"))
source("R/irradiance.R")
source("R/resistance.R")

test_that("irradiance is computed as expected.", {

        lamps <- data.frame(x=c(1,10), y=c(1,10), z=c(10,5))
        r <- raster::raster(nrows=100, ncols=100, ymn=0, ymx=10, xmn=0, xmx=10)
        soft_surf <- r
        soft_surf[] = 0
        hard_surf <- r
        hard_surf[] = 0
        hard_surf[,50:60] = 20
        hard_surf[50:60,80:90] = 20
        r_dtm <- r
        r_dtm[] = 0
        buildings <- r
        buildings[] = 0

        ext <- 10

        pi <- cal_lamp_irradiance(lamps, soft_surf, hard_surf, r_dtm, ext)
        expect_equal(sum(pi[75:80,70:80]), 0)
        expect_true(sum(pi[]) > 0)

        lamps <- data.frame(x=c(10), y=c(10), z=c(5))
        soft_surf[] = 0
        hard_surf[] = 0
        hard_surf[,50:60] = 20

        pi <- cal_lamp_irradiance(lamps, soft_surf, hard_surf, r_dtm, ext)

        soft_surf[50:70,] = 10

        pi2 <- cal_lamp_irradiance(lamps, soft_surf, hard_surf, r_dtm, ext)

        expect_equal(pi[1:5, 90:100], pi2[1:5, 90:100])
        expect_true(sum(pi[90:100,] - pi2[90:100,]) > 0)


})