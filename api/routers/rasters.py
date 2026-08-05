"""Raster router: serve raster PNGs and ZIP downloads."""

import logging
import os
import re
import tempfile
import zipfile

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from middleware.auth import require_auth
from services.redis import get_redis

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/rasters", tags=["rasters"])


async def _resolve_task_id(task_id: str) -> str:
    """Look up the internal work-directory hash for a Celery task ID."""
    redis = get_redis()
    h = await redis.get(f"task_to_hash:{task_id}")
    if not h:
        raise HTTPException(status_code=404, detail="Job not found or results expired")
    return h


def _get_job_dir(task_id: str) -> str:
    base = os.environ.get("PIPELINE_WORK_DIR", "/tmp/circuitscape")
    return os.path.join(base, task_id)


def _render_png(tif_path: str, png_path: str, circular_mask: bool, colormap: str) -> None:
    """Sync helper (runs in a threadpool): convert a GeoTIFF to PNG."""
    from services.raster_service import get_bounds_for_tif, tif_to_png
    bounds = get_bounds_for_tif(tif_path)
    tif_to_png(tif_path, png_path, bounds, circular_mask=circular_mask, colormap=colormap)


def _build_zip(job_dir: str, zip_path: str) -> None:
    """Sync helper (runs in a threadpool): archive all result files into zip_path."""
    results_files = []
    for f in sorted(os.listdir(job_dir)):
        if f.endswith(".tif"):
            results_files.append(os.path.join(job_dir, f))
    images_dir = os.path.join(job_dir, "images")
    if os.path.isdir(images_dir):
        for f in sorted(os.listdir(images_dir)):
            if f.endswith(".png"):
                results_files.append(os.path.join(images_dir, f))

    if not results_files:
        raise FileNotFoundError("No result files found")

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for fp in results_files:
            arcname = os.path.relpath(fp, job_dir)
            zf.write(fp, arcname)


@router.get("/{task_id}/{layer}.png")
async def get_raster_png(task_id: str, layer: str, _token: str = Depends(require_auth)):
    """Serve a raster layer as a PNG image."""
    if not re.match(r'^[a-zA-Z0-9_-]+$', layer):
        raise HTTPException(status_code=400, detail="Invalid layer name")
    h = await _resolve_task_id(task_id)
    job_dir = _get_job_dir(h)
    png_path = os.path.join(job_dir, "images", f"{layer}.png")

    if not os.path.exists(png_path):
        tif_path = os.path.join(job_dir, f"{layer}.tif")
        if not os.path.exists(tif_path):
            raise HTTPException(status_code=404, detail=f"Layer {layer} not found for job {task_id}")

        os.makedirs(os.path.join(job_dir, "images"), exist_ok=True)
        # Render to a temp file then atomically rename so a concurrent request
        # never serves a partially-written PNG. Runs in a threadpool so raster
        # I/O + matplotlib don't block the event loop for other requests.
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


@router.get("/{task_id}/download")
async def download_results(task_id: str, _token: str = Depends(require_auth)):
    """Download all result rasters as a ZIP file."""
    h = await _resolve_task_id(task_id)
    job_dir = _get_job_dir(h)
    if not os.path.isdir(job_dir):
        raise HTTPException(status_code=404, detail="Job not found")

    fd, zip_path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    try:
        await run_in_threadpool(_build_zip, job_dir, zip_path)
    except FileNotFoundError:
        os.unlink(zip_path)
        raise HTTPException(status_code=404, detail="No result files found")
    except Exception as e:
        os.unlink(zip_path)
        logger.error("Failed to create ZIP for task %s: %s", task_id, e)
        raise HTTPException(status_code=500, detail="Failed to create results archive")

    # BackgroundTask deletes the temp ZIP after the response has been sent;
    # without this every download leaked a file into the container's /tmp.
    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename="results.zip",
        headers={"Content-Disposition": "attachment; filename=results.zip"},
        background=BackgroundTask(os.unlink, zip_path),
    )
