#!/bin/bash
set -euo pipefail

DB_HOST="${DATABASE_HOST:-localhost}"

DB_NAME="${DATABASE_NAME:-${POSTGRES_DB:-os}}"
DB_USER="${DATABASE_USER:-${POSTGRES_USER:-bats}}"
DB_PORT="${DATABASE_PORT:-5432}"
DB_PASSWORD="${DATABASE_PASSWORD:-${POSTGRES_PASSWORD:-bats}}"
SEED_DIR="/seed-data"

export PGPASSWORD="$DB_PASSWORD"

DB_HOST="${DATABASE_HOST:-}"
if [ -n "$DB_HOST" ]; then
    PSQL=(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME")
else
    PSQL=(psql -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME")
fi

"${PSQL[@]}" -q -c "CREATE EXTENSION IF NOT EXISTS postgis;"
"${PSQL[@]}" -q -c "CREATE EXTENSION IF NOT EXISTS postgis_raster;"

echo "=== seeding ==="

echo "[umami database]..."
"${PSQL[@]}" -q -c "CREATE DATABASE umami" 2>/dev/null || true

for table in roads rivers buildings; do
    echo "[$table]..."
    shp2pgsql -s 27700 -c -I -D "$SEED_DIR/gis/$table/$table.shp" "$table"  2>/dev/null | "${PSQL[@]}" -q >/dev/null
done

for table in dtm dsm lcm; do
    echo "[$table]..."
    raster2pgsql -s 27700 -I "$SEED_DIR/gis/$table"/*.tif "$table" 2>/dev/null | "${PSQL[@]}" -q >/dev/null
done

for table in dtm dsm lcm; do
    otable="o_10_$table"
    echo "[$otable]..."
    "${PSQL[@]}" -q -c "DROP TABLE IF EXISTS $otable;"
    "${PSQL[@]}" -q -c \
        "CREATE TABLE $otable AS SELECT ST_Resample(ST_Union(rast), 10.0, 10.0) AS rast FROM $table;"
    "${PSQL[@]}" -q -c \
        "CREATE INDEX IF NOT EXISTS sidx_${otable}_r ON $otable USING GIST (ST_ConvexHull(rast));"
done

for table in dtm dsm lcm o_10_dtm o_10_dsm o_10_lcm; do
    echo "[tile_extent] $table..."
    "${PSQL[@]}" -q -c \
        "ALTER TABLE $table ADD COLUMN IF NOT EXISTS tile_extent geometry(Polygon,27700);"
    "${PSQL[@]}" -q -c \
        "UPDATE $table SET tile_extent = ST_Envelope(rast) WHERE tile_extent IS NULL;"
    "${PSQL[@]}" -q -c \
        "CREATE INDEX IF NOT EXISTS sidx_${table}_te ON $table USING GIST (tile_extent);"
done

echo "[vacuum]..."
"${PSQL[@]}" -q -c "VACUUM ANALYZE;"
echo "=== done ==="