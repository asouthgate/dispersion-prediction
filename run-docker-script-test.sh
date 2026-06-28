#!/bin/bash
set -e

rm -rf tmp/script-output/
mkdir -p tmp/script-output/
docker compose up -d
sleep 10

echo "Running resistance pipeline"
docker compose exec api Rscript --no-init-file test/test_r_pipeline.R

echo "Creating inputs.json for circuitscape"
docker compose exec api bash -c 'cat > /tmp/circuitscape/test_output/inputs.json << JSONEOF
{"roost":{"easting":287500,"northing":77500,"radius":500},"params":{"resolution":10,"n_circles":5},"lamps":[]}
JSONEOF'

echo "Running circuitscape pipeline"
docker compose exec api Rscript --no-init-file scripts/run_circuitscape.R /tmp/circuitscape/test_output/inputs.json

echo "Copying results"
docker compose cp api:/tmp/circuitscape/test_output/. ./tmp/script-output/
docker compose down
echo "Done — results in tmp/script-output/"
ls -la tmp/script-output/
