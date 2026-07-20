cd frontend/gsbio-engine && npm run build && cd ../..
docker build --network=host -t dispersion-prediction-app-frontend -f docker/Dockerfile.frontend . --build-context gsbio=./frontend/gsbio-engine
docker build -t dispersion-prediction-app-api -f docker/Dockerfile.backend .
docker build -t dispersion-prediction-app-postgis -f docker/Dockerfile.gis .
