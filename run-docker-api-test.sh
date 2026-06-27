#!/bin/bash
set -e

API_URL="${API_URL:-http://localhost:8000}"
OUTPUT_DIR="tmp/api-output"

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

echo "=== Starting stack ==="
docker compose up -d

echo "=== Waiting for API ($API_URL) ==="
for i in $(seq 1 30); do
    if curl -sf "$API_URL/api/health" > /dev/null 2>&1; then
        echo "API is ready."
        break
    fi
    echo "  attempt $i/30..."
    sleep 2
done

echo "=== Running API test ==="
python3 test/run_api_test.py --api-base "$API_URL" --out "$OUTPUT_DIR"

echo "=== Copying TIFs from container ==="
JOB_ID=$(cat "$OUTPUT_DIR/.job_id" 2>/dev/null || echo "")
if [ -n "$JOB_ID" ]; then
    docker compose cp "api:/tmp/circuitscape/${JOB_ID}/." "./${OUTPUT_DIR}/"
    echo "Copied job $JOB_ID files."
else
    echo "WARNING: no job_id found, skipping file copy."
fi

echo "=== Tearing down ==="
docker compose down

echo "=== Output in $OUTPUT_DIR/ ==="
ls -la "$OUTPUT_DIR/"
