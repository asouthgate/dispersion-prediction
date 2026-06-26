# Introduction

This repository contains the code that implements the *Predicting bat dispersion through urban environments* project. It now has two interfaces:

- **React + FastAPI** (new) — a TypeScript/React frontend using the `gsbio-engine` for map drawing and a FastAPI Python backend that calls the existing R pipeline as a subprocess.
- **Shiny** (legacy) — the original R Shiny app.

Most of the calculations are performed by [R](https://www.r-project.org) to set up the inputs to the [Circuitscape](https://docs.circuitscape.org/Circuitscape.jl/latest/) calculation that is implemented in [Julia](https://julialang.org). The app queries a [PostGIS](https://postgis.net) database for the vector and raster data required to perform the calculations.

# Quick Start (React + FastAPI)

Build the engine, then start the API and frontend in two terminals:

```bash
# Terminal 1 — build and start the API
cd api
pip install -r requirements.txt       # or use the existing .venv
.venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Terminal 2 — build and start the frontend
cd gsbio-engine && npm install && npm run build
cd ../frontend && npm install && npm run dev -- --port 5180 --host 0.0.0.0
```

Open `http://localhost:5180`. The frontend runs its own Vite dev server on port 5180; it proxies pipeline requests to the API on port 8000.

## Running tests

```bash
# engine unit tests
cd gsbio-engine && npx vitest run

# frontend type-check + build
cd frontend && npm run build
```

## Project structure

```
frontend/       React + TypeScript + gsbio-engine (Vite)
  src/
    components/   MapView, SidePanel, RoostPanel, ParameterPanel, FeaturePanel, GeneratePanel, FileUpload
    models/       horseshoeBat model definition + executor (API polling)
    utils/        WGS84 ↔ BNG coordinate transforms (proj4)
api/            FastAPI Python backend
  routers/       POST /api/pipeline/{coverage,resistance,current}, GET /api/pipeline/{job_id}
  services/      R subprocess bridge, PostGIS queries, raster → PNG conversion
gsbio-engine/   Simulation engine (symlinked, built separately)
app/            Legacy React prototype (not used)
```



# Installation

## Centos Packages

Install the following Centos packages with `yum`:

```bash
sudo yum install udunits2-devel
sudo yum install geos geos-devel
sudo yum install postgresql-devel
```

## R Packages

Run the following commands in the R console to install the required packages:

```R
install.packages("glue")
install.packages("JuliaCall")
install.packages("leaflet")
install.packages("R6")
install.packages("raster")
install.packages("rpostgis")
install.packages("sf")
install.packages("shiny")
install.packages("shinyBS")
install.packages("shinyjs")
install.packages("stringr")
install.packages("uuid")
install.packages("vroom")
```

## Julia Package

Run the following commands in the Julia console to install the required Circuitscape package:

```julia
using Pkg
Pkg.add("Circuitscape")
```

# Environment Variables

The default values for the PostgreSQL database name and the PostgreSQL port are:

```bash
DATABASE_NAME="os"
DATABASE_PORT=5432
```

Configure any of these values by creating a `.env` file with different values, e.g.:

```bash
DATABASE_PORT=5555
DATABASE_NAME="my-bat-data"
```

# Software Versions

The app runs with the following software versions:

|Software|Version|
|--------|-------|
|R       |4.0.4  |
|Julia   |1.5.4  |
|Postgres|13.2   |
|PostGIS |3.1.1  |

# Data

The data is all open source. The shapefiles for buildings, rivers and roads are from Ordnance Survey:

* https://www.ordnancesurvey.co.uk/business-government/products/open-map-rivers
* https://www.ordnancesurvey.co.uk/business-government/products/open-map-roads
* https://www.ordnancesurvey.co.uk/business-government/products/open-map-local
 
The landcover is from the CEH landcover map:

* https://www.ceh.ac.uk/services/land-cover-map-2015
 
Lidar DTM/DSM is also used to figure out where hedgerows/forest is, which is available from the government: 

* https://data.gov.uk/dataset/fba12e80-519f-4be2-806f-41be9e26ab96/lidar-composite-dsm-2017-2m
* https://data.gov.uk/dataset/002d24f0-0056-4176-b55e-171ba7f0e0d5/lidar-composite-dtm-2017-2m


# Resources

Some useful articles:

* [How can Postgis and R be used as a GIS?](https://rstudio-pubs-static.s3.amazonaws.com/304489_1a4dff62928e4ffeb4267e15cff254ca.html)
