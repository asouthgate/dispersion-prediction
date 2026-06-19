# Test Stack

## Starting the stack

From the project root:

```bash
docker-compose up -d          # start in background
docker-compose up -d --build  # start with image rebuild
```

```bash
docker-compose down              # stop and remove containers
docker-compose down --volumes    # also remove the database data volume
```

## Seeding data

Place GIS data files in `test/data/seed/gis/` subdirectories (see `test/data/seed/README.md`), then:

```bash
python test/run-test-stack.py seed
```

This runs `load-test-data.py` inside the postgis container, which loads shapefiles and GeoTIFFs into the database.

## Running tests

```bash
python test/run-test-stack.py test
```