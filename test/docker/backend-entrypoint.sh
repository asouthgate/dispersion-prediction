#!/bin/bash
set -e

echo "=== backend entrypoint ==="

if [ -n "${DATABASE_HOST}" ]; then
    echo "waiting for postgis at ${DATABASE_HOST}:${DATABASE_PORT:-5432}..."
    max_attempts=60
    attempt=0
    while ! pg_isready -h "${DATABASE_HOST}" -p "${DATABASE_PORT:-5432}" -U "${DATABASE_USER:-bats}" -d "${DATABASE_NAME:-os}" -q 2>/dev/null; do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge "$max_attempts" ]; then
            echo "WARNING: postgis not ready after ${max_attempts} attempts, continuing anyway..."
            break
        fi
        sleep 2
    done
    if [ "$attempt" -lt "$max_attempts" ]; then
        echo "postgis is ready."
    fi
fi

export DATABASE_HOST=${DATABASE_HOST:-postgis}
export DATABASE_NAME=${DATABASE_NAME:-os}
export DATABASE_PORT=${DATABASE_PORT:-5432}
export DATABASE_USER=${DATABASE_USER:-bats}
export DATABASE_PASSWORD=${DATABASE_PASSWORD:-bats}

echo "generating ~/.bats.cfg..."
envsubst < /opt/bats.cfg.template > ~/.bats.cfg
echo "done."

echo "starting uvicorn..."
exec python3 -m uvicorn main:app --app-dir /app/api --host 0.0.0.0 --port 8000
