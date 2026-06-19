library(sf)

read_shapefile <- function(dsn, layer) {
    sf_obj <- sf::st_read(dsn, layer, quiet = TRUE)
    as(sf_obj, "Spatial")
}

write_shapefile <- function(obj, dsn, layer) {
    sf_obj <- sf::st_as_sf(obj)
    sf::st_write(sf_obj, dsn, layer, driver = "ESRI Shapefile", delete_layer = TRUE, quiet = TRUE)
}