library(testthat)
setwd(getOption("project_root"))
source(file.path(getOption("project_root"), "R/drawing.R"))

test_that("DrawnPolygon stores what it was given correctly.", {
    dp <- DrawnPolygon$new(j = 1, type = "building")
    dp$set_vals(c(1, 2, 3, 4, 1), c(5, 6, 7, 8, 5))
    dp$is_complete <- TRUE
    p <- dp$get_shape()
    expect_equal(p@coords[1, ], c(1, 5))
    expect_equal(p@coords[3, ], c(3, 7))
})

test_that("Extracting data gives the types expected.", {
    # Can only be used with shiny
})