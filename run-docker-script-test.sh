rm -rf tmp/script-output/
mkdir -p tmp/script-output/
docker compose up -d
sleep 10
docker compose exec api Rscript --no-init-file test/test_r_pipeline.R
docker compose cp api:/tmp/circuitscape/test_output/. ./tmp/script-output/
docker compose down
