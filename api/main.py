import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import config
from routers import analytics, pipeline, rasters, auth, pmtiles

config.setup_logging()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Uvicorn has configured its loggers by now. Override the
    # access-log handler format so every access line carries a datetime
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    for h in logging.getLogger("uvicorn.access").handlers:
        h.setFormatter(fmt)

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
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(pipeline.router, prefix="/api")
app.include_router(rasters.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(pmtiles.router, prefix="/api")
app.include_router(analytics.router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok"}
