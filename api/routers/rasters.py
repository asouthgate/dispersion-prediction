"""Raster router: serve raster PNGs and ZIP downloads."""

import os
import logging
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/rasters", tags=["rasters"])


def _get_job_dir(job_id: str) -> str:
    base = os.environ.get("PIPELINE_WORK_DIR", "/tmp/circuitscape")
    d = os.path.join(base, job_id)
    if os.path.isdir(d):
        return d
    from .pipeline import _jobs, _lock
    with _lock:
        job = _jobs.get(job_id)
    if job and job.get("work_dir"):
        return job["work_dir"]
    return d


@router.get("/{job_id}/{layer}.png")
async def get_raster_png(job_id: str, layer: str):
    """Serve a raster layer as a PNG image."""
    job_dir = _get_job_dir(job_id)
    png_path = os.path.join(job_dir, "images", f"{layer}.png")

    if not os.path.exists(png_path):
        # Try the TIF path and convert on-demand
        tif_path = os.path.join(job_dir, f"{layer}.tif")
        if not os.path.exists(tif_path):
            raise HTTPException(status_code=404, detail=f"Layer {layer} not found for job {job_id}")

        from services.raster_service import tif_to_png, get_bounds_for_tif
        os.makedirs(os.path.join(job_dir, "images"), exist_ok=True)
        try:
            bounds = get_bounds_for_tif(tif_path)
            tif_to_png(tif_path, png_path, bounds, circular_mask=not layer.endswith("_clipped"))
        except Exception as e:
            logger.error("Failed to convert %s to PNG: %s", layer, e)
            raise HTTPException(status_code=500, detail="Failed to render raster image")

    return FileResponse(
        png_path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/{job_id}/download")
async def download_results(job_id: str):
    """Download all result rasters as a ZIP file."""
    job_dir = _get_job_dir(job_id)
    if not os.path.isdir(job_dir):
        raise HTTPException(status_code=404, detail="Job not found")

    import tempfile
    import zipfile

    # Collect all TIF files
    tif_files = []
    for f in sorted(os.listdir(job_dir)):
        if f.endswith(".tif"):
            tif_files.append(os.path.join(job_dir, f))
    for f in sorted(os.listdir(os.path.join(job_dir, "images"))):
        if f.endswith(".png"):
            tif_files.append(os.path.join(job_dir, "images", f))

    if not tif_files:
        raise HTTPException(status_code=404, detail="No result files found")

    try:
        fd, zip_path = tempfile.mkstemp(suffix=".zip")
        os.close(fd)

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for fp in tif_files:
                arcname = os.path.relpath(fp, job_dir)
                zf.write(fp, arcname)

        return FileResponse(
            zip_path,
            media_type="application/zip",
            filename="results.zip",
            headers={"Content-Disposition": "attachment; filename=results.zip"},
        )
    except Exception as e:
        logger.error("Failed to create ZIP for job %s: %s", job_id, e)
        raise HTTPException(status_code=500, detail="Failed to create results archive")
