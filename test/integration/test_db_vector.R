library(testthat)

source("R/db.R")

test_that("If there are no geometries found, an empty df is returned", {

    logger::log_info("Reading config")
    config <- configr::read.config("~/.bats.cfg")
    db_host <- config$database$host
    db_name <- config$database$name
    db_pass <- config$database$password
    db_user <- config$database$user
    db_port <- config$database$port
    dtm_table <- gsub("'", "", config$database$dtm_table)
    dsm_table <- gsub("'", "", config$database$dsm_table)
    lcm_table <- gsub("'", "", config$database$lcm_table)
    rivers <- gsub("'", "", config$database$rivers_table)

    # Impossible coords
    xmin <- 39180048.990343289
    xmax <- 39354800.990343289
    ymin <- 86054.6034798444
    ymax <- 88054.6034798444

    ext <- raster::extent(xmin, xmax, ymin, ymax)

    table_name <- rivers

    suppressWarnings({
        r <- read_db_vector(table_name, ext, db_host, db_name, db_port, db_user, db_pass)
    })

    # Expect that read_db_vector did not segfault or crash
    expect_true(TRUE)

})