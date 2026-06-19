library(testthat)
library(R6)
library(glue)
library(rpostgis)
library(JuliaCall)

source("R/algorithm_parameters.R")
source("R/db.R")
source("R/transform.R")

test_that("Julia is accessible", {
    com <- "julia -e 'print(sqrt(2))'"
    system(com)
    expect_equal(TRUE, TRUE)
})

test_that("Circuitscape is accessible", {
    # tmp bugfix; precedence works badly with libcurl
    Sys.unsetenv("LD_LIBRARY_PATH")
    system("julia -e \"using Circuitscape\"")
    expect_equal(TRUE, TRUE)
})

test_that("Vector databases are available", {

    config <- configr::read.config("~/.bats.cfg")
    database_host <- config$database$host
    database_name <- config$database$name
    database_password <- config$database$password
    database_user <- config$database$user
    database_port <- config$database$port
    roads_table <- gsub("'", "", config$database$roads_table)
    rivers_table <- gsub("'", "", config$database$rivers_table)
    buildings_table <- gsub("'", "", config$database$buildings_table)

    algorithm_parameters <- AlgorithmParameters$new(
        Roost$new(397093.199, 87698.191, 3000),
        RoadResistance$new(buffer=200, resmax=10, xmax=5),
        RiverResistance$new(buffer=200, resmax=10, xmax=5),
        LandscapeResistance$new(resmax=10, xmax=5),
        LinearResistance$new(buffer=200, resmax=10, xmax=5, rankmax=10),
        LampResistance$new(resmax=10, xmax=5, ext=100)
    )

    ext <- create_extent(algorithm_parameters$roost$x, algorithm_parameters$roost$y, algorithm_parameters$roost$radius)

    suppressWarnings({
        x <- read_db_vector(rivers_table, ext, database_host, database_name, database_port, database_user, database_password)
        y <- read_db_vector(roads_table, ext, database_host, database_name, database_port, database_user, database_password)
        z <- read_db_vector(buildings_table, ext, database_host, database_name, database_port, database_user, database_password)

        expect_gt(length(x), 0)
        expect_gt(length(y), 0)
        expect_gt(length(z), 0)
    })
})
#> Vector database SIT passed 🥳

test_that("Raster databases are available", {

    config <- configr::read.config("~/.bats.cfg")
    database_name <- config$database$name
    database_password <- config$database$password
    database_host <- config$database$host
    database_user <- config$database$user
    database_port <- config$database$port
    dtm_table <- gsub("'", "", config$database$dtm_table)
    dsm_table <- gsub("'", "", config$database$dsm_table)
    lcm_table <- gsub("'", "", config$database$lcm_table)

    algorithm_parameters <- AlgorithmParameters$new(
        Roost$new(397093.199, 87698.191, 3000),
        RoadResistance$new(buffer=200, resmax=10, xmax=5),
        RiverResistance$new(buffer=200, resmax=10, xmax=5),
        LandscapeResistance$new(resmax=10, xmax=5),
        LinearResistance$new(buffer=200, resmax=10, xmax=5, rankmax=10),
        LampResistance$new(resmax=10, xmax=5, ext=100)
    )

    ext <- create_extent(algorithm_parameters$roost$x, algorithm_parameters$roost$y, algorithm_parameters$roost$radius)

    suppressWarnings({
        dtm <- read_db_raster(dtm_table, ext, database_host, database_name, database_port, database_user, database_password)
        dsm <- read_db_raster(dsm_table, ext, database_host, database_name, database_port, database_user, database_password)
        lcm <- read_db_raster(lcm_table, ext, database_host, database_name, database_port, database_user, database_password)

        expect_gt(length(dtm), 0)
        expect_gt(length(dsm), 0)
        expect_gt(length(lcm), 0)
    })
})
#> Raster database SIT passed 🥳
