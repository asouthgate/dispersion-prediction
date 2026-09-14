"""Raster router: serve raw raster and vector files for client-side plotting."""

import logging
import os
import re

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from middleware.auth import require_auth
from services.access import check_job_access
from services.redis import get_redis

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/rasters", tags=["rasters"])


def _get_job_dir(task_id: str) -> str:
    base = os.environ.get("PIPELINE_WORK_DIR", "/tmp/circuitscape")
    return os.path.join(base, task_id)


@router.get("/{task_id}/raw/{layer}.tif")
async def get_raw_tif(task_id: str, layer: str, token: str = Depends(require_auth)):
    """Serve a raw GeoTIFF for client-side plotting/computation."""
    if not re.match(r'^[a-zA-Z0-9_-]+$', layer):
        raise HTTPException(status_code=400, detail="Invalid layer name")
    await check_job_access(get_redis(), task_id, token)
    job_dir = _get_job_dir(task_id)
    tif_path = os.path.join(job_dir, f"{layer}.tif")
    if not os.path.exists(tif_path):
        raise HTTPException(status_code=404, detail=f"Raw raster {layer} not found")
    return FileResponse(
        tif_path,
        media_type="image/tiff",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/{task_id}/raw/{layer}.geojson")
async def get_raw_geojson(task_id: str, layer: str, token: str = Depends(require_auth)):
    """Serve a raw GeoJSON file for client-side rasterization."""
    if not re.match(r'^[a-zA-Z0-9_-]+$', layer):
        raise HTTPException(status_code=400, detail="Invalid layer name")
    await check_job_access(get_redis(), task_id, token)
    job_dir = _get_job_dir(task_id)
    gj_path = os.path.join(job_dir, f"{layer}.geojson")
    if not os.path.exists(gj_path):
        raise HTTPException(status_code=404, detail=f"Raw GeoJSON {layer} not found")
    return FileResponse(
        gj_path,
        media_type="application/geo+json",
        headers={"Cache-Control": "public, max-age=3600"},
    )
