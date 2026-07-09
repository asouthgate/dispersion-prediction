#!/bin/bash
set -e

API_URL="${API_URL:-http://localhost:8000}"
OUTPUT_DIR="tmp/api-output"

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

if [ "${SKIP_BUILD:-}" != "true" ]; then
    bash build-images.sh
fi

echo "Starting stack"
docker compose down -v
docker compose up -d

echo "Waiting for API ($API_URL)"
for i in $(seq 1 30); do
    if curl -sf "$API_URL/api/health" > /dev/null 2>&1; then
        echo "API is ready."
        break
    fi
    echo "  attempt $i/30..."
    sleep 2
done

echo "Running resistance pipeline"
python3 test/run_pipeline.py --api-base "$API_URL" --stage resistance --out "$OUTPUT_DIR/resistance/"

echo "Running current (circuitscape) pipeline"
python3 test/run_pipeline.py --api-base "$API_URL" --stage current --out "$OUTPUT_DIR/current/"

echo "Testing PMTiles endpoint"
python3 test/test_pmtiles.py --api-base "$API_URL" --frontend-base "http://localhost:5180" --pmtiles-file test.pmtiles

echo "Running full-stack integration test"
python3 test/test_integration.py --api-base "$API_URL" --frontend-base "http://localhost:5180" --pmtiles-file test.pmtiles

echo "Copying outputs from container"
# Results live in hash-based dirs: copy all job output dirs
mkdir -p "$OUTPUT_DIR/container"
docker compose cp "api:/tmp/circuitscape/." "./${OUTPUT_DIR}/container/" 2>/dev/null || echo "  (no circuitscape dirs to copy, results downloaded via HTTP above)"

echo "Tearing down"
docker compose down

echo "Output in $OUTPUT_DIR/"
ls -la "$OUTPUT_DIR/"
