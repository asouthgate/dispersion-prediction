#!/bin/bash
set -e

API_URL="${API_URL:-http://localhost:8000}"
OUTPUT_DIR="tmp/api-output"

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

if [ "${SKIP_BUILD:-}" != "true" ]; then
  echo "Building api image"
  docker build -t dispersion-prediction-app-api -f test/docker/Dockerfile.backend .

  echo "Building frontend image"
  docker build -t dispersion-prediction-app-frontend \
    --build-context gsbio=gsbio-engine \
    -f test/docker/Dockerfile.frontend .
fi

echo "Starting stack"
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

echo "Copying outputs from container"
# Results live in hash-based dirs: copy all job output dirs
mkdir -p "$OUTPUT_DIR/container"
docker compose cp "api:/tmp/circuitscape/." "./${OUTPUT_DIR}/container/" 2>/dev/null || echo "  (no circuitscape dirs to copy, results downloaded via HTTP above)"

echo "Tearing down"
docker compose down

echo "Output in $OUTPUT_DIR/"
ls -la "$OUTPUT_DIR/"
