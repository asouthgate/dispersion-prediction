library(testthat)
source("R/drawing.R")

test_that("DrawnPolygon stores what it was given correctly.", {
    dp <- DrawnPolygon$new()
    dp$add_point(c(1, 2, 3, 4, 1), c(5, 6, 7, 8, 5))
    p <- dp$get_polygon()
    expect_equal(p@coords[1, ], c(1, 5))
    expect_equal(p@coords[3, ], c(3, 7))
})

test_that("Extracting data gives the types expected.", {
    # Can only be used with shiny
})
