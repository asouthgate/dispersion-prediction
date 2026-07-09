cd gsbio-engine && npm run build && cd ..
docker build --network=host -t dispersion-prediction-app-frontend -f test/docker/Dockerfile.frontend . --build-context gsbio=./gsbio-engine
docker build -t dispersion-prediction-app-api -f test/docker/Dockerfile.backend .
docker build -t dispersion-prediction-app-postgis -f test/docker/Dockerfile.gis .
