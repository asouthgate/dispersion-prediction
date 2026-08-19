"""Raster router: serve raster PNGs and raw files."""

import logging
import os
import re

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from middleware.auth import require_auth
from services.access import check_job_access
from services.redis import get_redis

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/rasters", tags=["rasters"])

_VALID_LAYER_IDS = frozenset({
    "coverage", "dtm", "dsm",
    "log_total_res", "total_res", "road_res", "river_res",
    "landscape_res", "linear_res", "soft_surf", "hard_surf",
    "generic_res", "lamp_res", "log_lamp_res",
    "log_current", "current",
})


def _get_job_dir(task_id: str) -> str:
    base = os.environ.get("PIPELINE_WORK_DIR", "/tmp/circuitscape")
    return os.path.join(base, task_id)


def _render_png(tif_path: str, png_path: str, circular_mask: bool, colormap: str) -> None:
    """Sync helper (runs in a threadpool): convert a GeoTIFF to PNG."""
    from services.raster_service import get_bounds_for_tif, tif_to_png
    bounds = get_bounds_for_tif(tif_path)
    tif_to_png(tif_path, png_path, bounds, circular_mask=circular_mask, colormap=colormap)


@router.get("/{task_id}/{layer}.png")
async def get_raster_png(task_id: str, layer: str, token: str = Depends(require_auth)):
    """Serve a raster layer as a PNG image."""
    if not re.match(r'^[a-zA-Z0-9_-]+$', layer):
        raise HTTPException(status_code=400, detail="Invalid layer name")
    if layer not in _VALID_LAYER_IDS:
        raise HTTPException(status_code=404, detail=f"Unknown layer: {layer}")
    await check_job_access(get_redis(), task_id, token)
    job_dir = _get_job_dir(task_id)
    png_path = os.path.join(job_dir, "images", f"{layer}.png")

    if not os.path.exists(png_path):
        tif_path = os.path.join(job_dir, f"{layer}.tif")
        if not os.path.exists(tif_path):
            raise HTTPException(status_code=404, detail=f"Layer {layer} not found for job {task_id}")

        os.makedirs(os.path.join(job_dir, "images"), exist_ok=True)
        tmp_path = f"{png_path}.{os.getpid()}.tmp"
        try:
            colormap = "plasma" if "current" in layer else "magma"
            await run_in_threadpool(
                _render_png, tif_path, tmp_path, "current" in layer, colormap
            )
            os.replace(tmp_path, png_path)
        except Exception as e:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            logger.error("Failed to convert %s to PNG: %s", layer, e)
            raise HTTPException(status_code=500, detail="Failed to render raster image")

    return FileResponse(
        png_path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/{task_id}/raw/{layer}.tif")
async def get_raw_tif(task_id: str, layer: str, token: str = Depends(require_auth)):
    """Serve a raw GeoTIFF for client-side computation."""
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
