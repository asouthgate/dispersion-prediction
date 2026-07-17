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

To deploy as a standalone single-node app. All containers use `network_mode: host`,
sharing the host's network stack — `localhost` works for inter-container communication.

## System components

The `docker-compose.prod.yml` stack runs four containers:

- **redis** (port 6379): Celery message broker and auth token store
- **api** (port 8000): FastAPI backend, serves `/api/*` including PMTiles
- **celery_worker**: async pipeline runner + beat (periodic cleanup)
- **umami** (port 3000): self-hosted web analytics

You'll also need:

- **Reverse proxy** (nginx) serves the built frontend statically and proxies `/api/` to `127.0.0.1:8000`.
  Example config:

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
sudo nano /etc/nginx/sites-available/dispersion.conf   # paste config above
sudo ln -s /etc/nginx/sites-available/dispersion.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow 80/tcp
```

## Prerequisites

- **PostgreSQL with PostGIS** (external, not in the prod compose)
- **Docker & Docker Compose**
- **nginx** (see above)
- `postgis` package for `shp2pgsql` / `raster2pgsql` CLI tools: `sudo apt install postgis`

## Setup steps

```bash
# 1. Create the application user and database
sudo -u postgres createuser -P bats   # enter password
sudo -u postgres createdb -O bats os

# 2. Install PostGIS extensions
sudo -u postgres psql -d os -c "CREATE EXTENSION IF NOT EXISTS postgis;"
sudo -u postgres psql -d os -c "CREATE EXTENSION IF NOT EXISTS postgis_raster;"

# 3. Place the PMTiles map file
mkdir -p /opt/dispersion-app/data
cp data/uk-global-base.pmtiles /opt/dispersion-app/data/

# 4. Seed the database with GIS test data
cd test/data
SEED_DIR=$(pwd)/seed DATABASE_HOST=localhost bash seed/seed-test-data.sh
cd ../..

# 5. Create the Umami analytics database
sudo -u postgres psql -c "CREATE DATABASE umami OWNER bats;"
sudo -u postgres psql -d umami -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
sudo -u postgres psql -d umami -c "GRANT ALL ON SCHEMA public TO bats;"

# 6. Build the API image
docker build -f test/docker/Dockerfile.backend -t dispersion-prediction-app-api:v1.0.0 .

# 7. Build the frontend
cd frontend && npm ci && npm run build && cd ..

# 8. Configure environment
cp .env.example .env
# Edit .env — at minimum set CORS_ORIGINS to your domain/IP,
# and change passwords and secrets from their defaults.

# 9. Start the stack
docker compose -f docker-compose.prod.yml up -d
```

## Optional: Redis overcommit

To suppress the Redis memory overcommit warning:

```bash
sudo sysctl vm.overcommit_memory=1
echo "vm.overcommit_memory = 1" | sudo tee -a /etc/sysctl.conf
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
