library(shiny)
library(testthat)

setwd(getOption("project_root"))

testServer(expr = {

    sample <- file.path(getOption("project_root"), "test/sample_drawings.zip")
    dp <- file.path(getOption("project_root"), "test/tmp/sample_drawings.zip")
    file.copy(sample, dp)
    
    session$setInputs(upload_file = list(datapath=dp))
    spdfs <- drawings$get_spatial_dfs(crs = "27700")

    expect_equal(nrow(spdfs$rivers), 1)
    expect_equal(nrow(spdfs$roads), 1)
    expect_equal(nrow(spdfs$lights), 1781) 
    expect_equal(nrow(spdfs$buildings), 1)

    drawings$delete(1)
    expect_null(spdfs$get_buildings)

})