"""FastAPI main application."""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import config
from routers import pipeline, rasters


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(config.PIPELINE_WORK_DIR, exist_ok=True)
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

@app.get("/api/health")
async def health():
    return {"status": "ok"}


# Serve frontend built files in production (dev uses Vite on port 5180)
frontend_dist = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.isdir(frontend_dist):
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
