library(shiny)
library(testthat)

testServer(expr = {

    # Test that the number of rows of each spatial dataframe is correct after uploading data

    sample <- paste0(getwd(),"/test/sample_drawings.zip")
    dp <- paste0(getwd(),"/test/tmp/sample_drawings.zip")
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

