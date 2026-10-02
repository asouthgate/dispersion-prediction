# Data sources

## Map data

Displayed map tiles on the app itself are sourced from [OpenStreetMap](https://www.openstreetmap.org/)
and extracted using [Planetiler](https://github.com/onthegomap/planetiler). See [here](https://github.com/onthegomap/planetiler/blob/main/NOTICE.md#data) for further details. This data is used purely for rendering vector data at a lower resolution and is not used in the models themselves.

## Raster & vector sources

Models themselves make use of vector and raster data from a range of sources:
* Shapefiles for [buildings](https://www.ordnancesurvey.co.uk/business-government/products/open-map-local), [rivers](https://www.ordnancesurvey.co.uk/business-government/products/open-map-rivers), and [roads](https://www.ordnancesurvey.co.uk/business-government/products/open-map-roads) from Ordnance Survey.
* The landcover is from the [CEH landcover map](https://www.ceh.ac.uk/services/land-cover-map-2015)
* [Lidar Digital Terrain Model (DTM)](https://data.gov.uk/dataset/fba12e80-519f-4be2-806f-41be9e26ab96/lidar-composite-dsm-2017-2m) and [Digital Surface Model (DSM)](https://data.gov.uk/dataset/002d24f0-0056-4176-b55e-171ba7f0e0d5/lidar-composite-dtm-2017-2m
)

## Uploads

Raw user imported data is only used in the user's browser to compute derived resistance maps. This
is performed using WebAssembly. Downstream resistance maps integrating all data sources are processed
by the backend server to compute current maps but are not stored. See [Sessions And Your Data](Sessions-And-Your-Data) for more information.
