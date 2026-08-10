docker build -f docker/Dockerfile.frontend.builder -t frontend-builder:latest .

docker run --rm \
  -v "$(pwd)":/app \
  -w /app/frontend/wasm-connectivity \
  frontend-builder:latest \
  wasm-pack build --target web --out-dir lib

docker run --rm \
  -v "$(pwd)":/app \
  -w /app/frontend/gsbio-engine \
  frontend-builder:latest \
  sh -c "npm install && npm run build"

docker run --rm \
  -v "$(pwd)":/app \
  -w /app/frontend \
  frontend-builder:latest \
  sh -c "npm install && npm run build"

docker build --network=host -t dispersion-prediction-app-frontend -f docker/Dockerfile.frontend . --build-context gsbio=./frontend/gsbio-engine
docker build -t dispersion-prediction-app-api -f docker/Dockerfile.backend .
docker build -t dispersion-prediction-app-postgis -f docker/Dockerfile.gis .
