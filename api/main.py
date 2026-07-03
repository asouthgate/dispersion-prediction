import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import config
from routers import pipeline, rasters, auth, pmtiles

config.setup_logging()


# This is startup code
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create the pipeline work directory if it doesn't exist, it will be needed later
    os.makedirs(config.PIPELINE_WORK_DIR, exist_ok=True)
    os.makedirs(config.PMTILES_DIR, exist_ok=True)
    yield


app = FastAPI(
    title="Horseshoe Bat Flight Line Predictor API",
    description="Backend API for bat dispersion prediction using Circuitscape",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(pipeline.router, prefix="/api")
app.include_router(rasters.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(pmtiles.router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok"}