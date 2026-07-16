# Introduction

This repository contains code for the dispersion-prediction app. 

# Developer Quick Start

Currently, this repository makes use of a submodule for the `gsbio` engine during 
development. Firstly, update the submodule:

```bash
git submodules update --init --recursive
```

Intall and build the engine with:

```bash
npm install && npm run build
```

The compose stack contains a self-seeding database. However, the `pmtiles` file needs to be 
available for serving map data. Ensure this available in `data/uk-global-base.pmtiles`. 

Then:

```bash
docker compose up
```
Open `http://localhost:5180`.

# Running tests

For the front-end:

```bash
# engine unit tests
cd gsbio-engine && npx vitest run

# frontend type-check + build
cd frontend && npm run build
```

For the back-end:

```bash
pytest api/test/ -v
```

For the integration/smoke tests:

```bash
bash run-docker-api-test.sh
```

# Deployment

To deploy as a standalone single-node app:

## System components

The `docker-compose.prod.yml` stack runs four containers plus a reverse proxy:

- **redis**: Celery message broker and auth token store
- **api**: FastAPI backend, serves `/api/*` including PMTiles
- **celery_worker**: async pipeline runner + beat
- **umami**: self-hosted web analytics

You'll also need:

- **Reverse proxy** (e.g. nginx) serves the built frontend statically, terminates TLS, and proxies `/api/` requests to `127.0.0.1:8000`. A sample nginx config is at `test/docker/nginx.conf`.

## Prerequisites

- External PostgreSQL with PostGIS (not included in the prod compose)
- The host path `/opt/dispersion-app/data/pmtiles` must exist and contain the required `.pmtiles` files
- Docker & Docker Compose

## First deploy

```bash
# Build the API image (or pull from your registry)
docker build -f test/docker/Dockerfile.backend -t dispersion-prediction-app-api:v1.0.0 .

# Build the frontend
cd frontend && npm ci && npm run build

# Copy and fill in environment variables, documentedin `env.example`
cp .env.example .env

# Start the stack
docker compose -f docker-compose.prod.yml up -d
```

# Data

The data is all open source. The shapefiles for buildings, rivers and roads are from Ordnance Survey:

* https://www.ordnancesurvey.co.uk/business-government/products/open-map-rivers
* https://www.ordnancesurvey.co.uk/business-government/products/open-map-roads
* https://www.ordnancesurvey.co.uk/business-government/products/open-map-local
 
The landcover is from the CEH landcover map:

* https://www.ceh.ac.uk/services/land-cover-map-2015
 
Lidar DTM/DSM is also used to figure out where hedgerows/forest is, which is available from: 

* https://data.gov.uk/dataset/fba12e80-519f-4be2-806f-41be9e26ab96/lidar-composite-dsm-2017-2m
* https://data.gov.uk/dataset/002d24f0-0056-4176-b55e-171ba7f0e0d5/lidar-composite-dtm-2017-2m
