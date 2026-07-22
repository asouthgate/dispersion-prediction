#!/bin/bash
set -e

echo "=== backend entrypoint ==="

if [ -n "${DATABASE_HOST}" ]; then
    echo "waiting for postgis at ${DATABASE_HOST}:${DATABASE_PORT}..."
    max_attempts=60
    attempt=0
    while ! pg_isready -h "${DATABASE_HOST}" -p "${DATABASE_PORT}" -U "${DATABASE_USER}" -d "${DATABASE_NAME}" -q 2>/dev/null; do
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

echo "generating ~/.bats.cfg..."
envsubst < /opt/bats.cfg.template > ~/.bats.cfg
echo "done."

if [ "$#" -gt 0 ]; then
    echo "starting: $*"
    exec "$@"
fi

echo "starting uvicorn..."
exec python3 -m uvicorn main:app --app-dir /app/api --host 0.0.0.0 --port ${API_PORT}
