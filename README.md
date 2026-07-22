# Introduction

This repository contains code for the dispersion-prediction app. 

# Developer Quick Start

Currently, this repository makes use of a submodule for the `gsbio` engine during 
development. Firstly, update the submodule:

```bash
git submodule update --init --recursive
```

Build the engine, frontend, and required images with

```bash
bash scripts/build.sh
```

The compose stack contains a self-seeding database. The `pmtiles` file needs to be 
available for serving map data. You can obtain vector data covering the UK by using `planetiler`
to fetch OpenStreetMap tiles.

```
docker run -e JAVA_TOOL_OPTIONS="-Xmx4g" -v "$(pwd)/data:/data"   ghcr.io/onthegomap/planetiler:latest   --download   --area=united-kingdom   --bounds=planet   --output=./data/uk-global-base.pmtiles
```

Ensure this available in `data/uk-global-base.pmtiles`. 

Next, copy the default example env variables:

```
cp .env.example .env
```

Then:

```bash
docker compose up
```

Open `http://localhost:5184`. A small region centered on `Chudleigh` will have pre-seeded test raster data.

# Running tests

For all unit tests run:

```bash
bash scripts/run-unit-tests.sh
```

For the integration/smoke tests:

```bash
bash scripts/run-docker-api-test.sh
```

# Architecture

The `docker-compose.yml` stack runs:

- **api**: FastAPI backend, serves `/api/*` including PMTiles
- **frontend**: nginx serving built files
- **redis**: Celery message broker and auth token store
- **celery_worker**: async pipeline runner + beat (periodic cleanup)
- **umami**: self-hosted web analytics
- **postgis**: for the development database serving geospatial data
- **umami-db**: postgres instance dedicated to small umami data; separated to make life easier with prod dbs.

In production, for `docker-compose.prod.yml`, PostGIS is ommitted, and assumed to be an external service.
In principle, the frontend can be served directly by a webserver and api via reverse proxy. 
Here, we use a frontend container and assume both frontend and backend are reverse proxied. 
This makes testing slightly easier but is an overhead.

# Deployment


## Prerequisites

- **PostgreSQL with PostGIS** (external, not in the prod compose)
- **Docker & Docker Compose**
- **nginx**
- `postgis` package for `shp2pgsql` / `raster2pgsql` CLI tools, which are bundled with the `postgis` package: 

```sudo apt install postgis```

You'll need to proxy `/api/` to `127.0.0.1:8084` and either serve the frontend directly
or proxy the to the frontend container. Example `nginx` config:

```nginx
server {
    listen 80;
    server_name _;
    root /opt/dispersion-app/frontend/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
        proxy_connect_timeout 10s;
    }
}
```

Install and enable:

```bash
sudo apt install nginx
sudo vim /etc/nginx/sites-available/dispersion.conf # paste config here
sudo ln -s /etc/nginx/sites-available/dispersion.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow 80/tcp
```

## Database setup

Ensure the PMTiles map file is in `data/uk-global-base.pmtiles`. This will be served as user-facing map data.

For the analytical pipeline, PostGIS is needed. Create the application user and database:

```bash
sudo -u postgres createuser -P user   # enter password
sudo -u postgres createdb -O user dbname
```

Install PostGIS extensions

```bash
sudo -u postgres psql -d os -c "CREATE EXTENSION IF NOT EXISTS postgis;"
sudo -u postgres psql -d os -c "CREATE EXTENSION IF NOT EXISTS postgis_raster;"
```

Upload the required data. See `test/data/seed/seed-test-data.sh` for an example.

Create the Umami analytics database

```bash
sudo -u postgres psql -c "CREATE DATABASE umami OWNER bats;"
sudo -u postgres psql -d umami -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
sudo -u postgres psql -d umami -c "GRANT ALL ON SCHEMA public TO bats;"
```

Configure the .env file:

```bash
cp .env.example .env  # change the defaults
```

Start the stack:

```bash
docker compose -f docker-compose.prod.yml up -d
```

# Data

The data is all open source. 

For vector data used to render the map, see

* https://www.openstreetmap.org/
* https://github.com/onthegomap/planetiler

The shapefiles for buildings, rivers and roads are from Ordnance Survey:

* https://www.ordnancesurvey.co.uk/business-government/products/open-map-rivers
* https://www.ordnancesurvey.co.uk/business-government/products/open-map-roads
* https://www.ordnancesurvey.co.uk/business-government/products/open-map-local
 
The landcover is from the CEH landcover map:

* https://www.ceh.ac.uk/services/land-cover-map-2015
 
Lidar DTM/DSM is also used to figure out where hedgerows/forest is, which is available from: 

* https://data.gov.uk/dataset/fba12e80-519f-4be2-806f-41be9e26ab96/lidar-composite-dsm-2017-2m
* https://data.gov.uk/dataset/002d24f0-0056-4176-b55e-171ba7f0e0d5/lidar-composite-dtm-2017-2m
