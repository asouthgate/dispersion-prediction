"""Pipeline router: start jobs, poll status, cancel."""

import logging
import os
import shutil
import subprocess
import threading
import time
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from services.raster_service import tif_to_png
from schemas.pipeline import (
    PipelineRequest,
    PipelineStartResponse,
    JobStatus,
    ResultLayerInfo,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pipeline", tags=["pipeline"])

_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _create_work_dir(job_id: str) -> str:
    base = os.environ.get("PIPELINE_WORK_DIR", "/tmp/circuitscape")
    work_dir = os.path.join(base, job_id)
    os.makedirs(work_dir, exist_ok=True)
    os.makedirs(os.path.join(work_dir, "images"), exist_ok=True)
    os.makedirs(os.path.join(work_dir, "circuitscape"), exist_ok=True)
    return work_dir


def _write_input_files(
    work_dir: str,
    roost: dict[str, Any] | None,
    features: list[dict[str, Any]],
    lamps: list[dict[str, Any]],
    params: dict[str, int | float],
) -> None:
    import json
    from services.r_bridge import wgs84_to_bng

    roost_bng = None
    if roost:
        easting, northing = wgs84_to_bng(roost["lng"], roost["lat"])
        roost_bng = {
            "easting": easting,
            "northing": northing,
            "radius": roost.get("radiusMeters", roost.get("radius_meters", 2500)),
        }

    input_data = {
        "roost": roost_bng,
        "params": params,
        "lamps": lamps,
        "feature_count": len(features),
    }
    with open(os.path.join(work_dir, "inputs.json"), "w") as f:
        json.dump(input_data, f, indent=2)


def _compute_extent_from_roost(roost: dict[str, Any], resolution: float = 10.0) -> tuple[float, float, float, float]:
    """Compute a square BNG extent centred on the roost with side 2×radius.

    Returns (xmin, ymin, xmax, ymax) in EPSG:27700.
    """
    from services.r_bridge import wgs84_to_bng

    easting, northing = wgs84_to_bng(roost["lng"], roost["lat"])
    radius = roost.get("radiusMeters", roost.get("radius_meters", 2500))

    xmin = easting - radius
    xmax = easting + radius
    ymin = northing - radius
    ymax = northing + radius

    logger.info(
        "Computed extent from roost (lng=%.6f lat=%.6f radius=%d): "
        "BNG (%.1f %.1f %.1f %.1f) res=%g",
        roost["lng"], roost["lat"], int(radius),
        xmin, ymin, xmax, ymax, resolution,
    )
    return (xmin, ymin, xmax, ymax)


def _run_coverage_python(work_dir: str, roost: dict[str, Any] | None, resolution: float = 10.0) -> tuple[list[dict[str, Any]], list[str]]:
    """Run coverage pipeline using Python directly (no R needed)."""
    import time as _time

    t0 = _time.monotonic()

    if not roost:
        raise ValueError("No roost provided — cannot compute coverage extent")

    _write_input_files(work_dir, roost, [], [], {})

    from services.db import fetch_rasters
    from services.raster_service import get_bounds_for_tif

    extent_bng = _compute_extent_from_roost(roost, resolution)
    logger.info("Fetching rasters for extent %s at resolution %g", extent_bng, resolution)
    rasters = fetch_rasters(extent_bng, resolution, work_dir)
    logger.info("Fetched %d rasters: %s", len(rasters), list(rasters.keys()))

    layers = []
    for name, path in rasters.items():
        bounds = get_bounds_for_tif(path)
        png_path = os.path.join(work_dir, "images", f"{name}.png")
        tif_to_png(path, png_path, bounds)
        layers.append({
            "id": name.upper(),
            "url": f"/api/rasters/{os.path.basename(work_dir)}/{name}.png",
            "bounds": list(bounds),
        })
        logger.debug("Layer %s: bounds=%s", name.upper(), bounds)

    elapsed = _time.monotonic() - t0
    if not layers:
        raise RuntimeError("Coverage pipeline produced no result layers — check database raster data")

    logger.info("Coverage pipeline completed in %.1fs, %d layers", elapsed, len(layers))
    return layers, []


def _check_r_available() -> tuple[bool, str]:
    """Check if Rscript and required scripts/packages are available.

    Returns (available: bool, message: str).
    """
    rscript = shutil.which("Rscript")
    if not rscript:
        return False, "R environment not configured. Resistance and Current pipelines require R. Only Coverage is available in this deployment."

    scripts = [
        os.path.join(REPO_ROOT, "scripts", "run_resistance_pipeline_json.R"),
        os.path.join(REPO_ROOT, "scripts", "run_circuitscape.R"),
    ]
    missing = [s for s in scripts if not os.path.exists(s)]
    if missing:
        return False, f"Pipeline scripts not found: {', '.join(os.path.basename(s) for s in missing)}"

    return True, ""


def _sanitize_error(message: str) -> str:
    """Replace raw system-level error messages with user-friendly ones.

    Never exposes internal paths or tracebacks.
    """
    lower = message.lower()

    if "no such file or directory" in lower and "rscript" in lower:
        return "R environment not configured. Resistance and Current pipelines require R. Only Coverage is available in this deployment."
    if "r script not found" in lower:
        return "The pipeline script is not available on this server."
    if "timed out" in lower or "timeout" in lower:
        return "The pipeline took too long to complete. Try a smaller area or higher resolution value."
    if "no result layers" in lower or "produced no output" in lower or "produced no result layers" in lower:
        return "No data is available for the selected area. Try a different location."
    if "permission denied" in lower:
        return "The server is unable to access required data files."
    if "database" in lower or "postgres" in lower:
        return "Unable to connect to the spatial database. Please try again later."
    known_safe = (
        "no roost defined",
        "unknown pipeline stage",
        "r environment not configured",
        "the pipeline took too long",
        "no data is available",
    )
    lower_clean = lower.strip()
    if any(lower_clean.startswith(p) for p in known_safe):
        return message
    if len(message) > 200:
        return "An internal error occurred. Please try again or contact support."
    return "An internal error occurred. Please try again or contact support."


def _run_r_pipeline(work_dir: str, stage: str, roost: dict[str, Any] | None,
                    features: list[dict[str, Any]], lamps: list[dict[str, Any]],
                    params: dict[str, int | float], _job_id: str = "") -> tuple[list[dict[str, Any]], list[str]]:
    """Run an R pipeline script via subprocess.

    Returns (layers, warnings).  Stores the subprocess handle in _jobs for cancellation.
    """
    import re
    import time as _time

    t0 = _time.monotonic()

    from services.r_bridge import _write_input_files as wif, collect_results

    available, err_msg = _check_r_available()
    if not available:
        raise RuntimeError(err_msg)

    wif(work_dir, roost, features, lamps, params)

    r_script_map = {
        "resistance": "scripts/run_resistance_pipeline_json.R",
        "current": "scripts/run_circuitscape.R",
    }
    rscript = r_script_map.get(stage)
    if not rscript:
        raise ValueError(f"Unknown stage: {stage}")

    script_path = os.path.join(REPO_ROOT, rscript)
    if not os.path.exists(script_path):
        raise FileNotFoundError(f"R script not found: {rscript}")

    env = os.environ.copy()
    env["R_PIPELINE_WORKDIR"] = work_dir

    logger.info("Running R pipeline: stage=%s script=%s", stage, script_path)
    try:
        proc = subprocess.Popen(
            ["Rscript", "--no-init-file", script_path, os.path.join(work_dir, "inputs.json")],
            cwd=REPO_ROOT, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        if _job_id:
            with _lock:
                if _job_id in _jobs:
                    _jobs[_job_id]["_proc"] = proc
        stdout, stderr = proc.communicate(timeout=600)
    except FileNotFoundError:
        raise RuntimeError(
            "R environment not configured. Resistance and Current pipelines require R. "
            "Only Coverage is available in this deployment."
        )
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, stderr = proc.communicate()
        raise RuntimeError(
            "The pipeline took too long to complete. Try a smaller study area or a higher resolution value."
        )

    warnings = re.findall(r'WARN\s+\[.*?\]\s+(.*)', stderr or "")

    if proc.returncode != 0:
        cancelled = False
        if _job_id:
            with _lock:
                cancelled = _job_id in _jobs and _jobs[_job_id].get("status") == "cancelled"
        if cancelled:
            logger.info("R pipeline was cancelled (rc=%d), not treating as error", proc.returncode)
            return [], warnings
        stderr_tail = (stderr or "")[-500:] or "(no output)"
        logger.error("R pipeline failed (rc=%d): %s", proc.returncode, stderr_tail)
        raise RuntimeError(f"R pipeline failed (rc={proc.returncode}): {stderr_tail[:300]}")

    layers_raw = collect_results(work_dir)
    if not layers_raw:
        raise RuntimeError(
            "No data is available for the selected area. "
            "The pipeline completed but produced no result layers — "
            "the database may not have raster data covering this location."
        )

    result_layers = []
    for layer in layers_raw:
        tif_path = layer["tif_path"]
        png_name = f"{layer['id']}.png"
        png_path = os.path.join(work_dir, "images", png_name)
        from services.raster_service import get_bounds_for_tif
        bounds = get_bounds_for_tif(tif_path)
        tif_to_png(tif_path, png_path, bounds)
        result_layers.append({
            "id": layer["name"],
            "url": f"/api/rasters/{os.path.basename(work_dir)}/{layer['id']}.png",
            "bounds": list(bounds),
        })

    elapsed = _time.monotonic() - t0
    logger.info("R pipeline completed in %.1fs, %d layers, %d warnings", elapsed, len(result_layers), len(warnings))
    return result_layers, warnings


def _run_in_background(job_id: str, work_dir: str, stage: str,
                       roost: dict[str, Any] | None,
                       features: list[dict[str, Any]],
                       lamps: list[dict[str, Any]],
                       params: dict[str, int | float]):
    t0 = time.monotonic()
    resolution = params.get("resolution", 10)
    logger.info("Job %s: starting %s pipeline (resolution=%.0f, roost=%s, features=%d, lamps=%d)",
                job_id, stage, resolution,
                f"({roost['lng']:.4f},{roost['lat']:.4f} r={roost.get('radiusMeters',2500)})" if roost else "none",
                len(features), len(lamps))

    try:
        with _lock:
            if job_id in _jobs and _jobs[job_id].get("status") != "cancelled":
                _jobs[job_id]["status"] = "running"
                _jobs[job_id]["progress_label"] = f"Running {stage} pipeline..."

        if stage == "coverage":
            if not roost:
                raise ValueError("No roost defined — place a roost on the map before running coverage.")
            with _lock:
                if job_id in _jobs:
                    _jobs[job_id]["progress_label"] = "Fetching coverage data..."
            layers, warnings = _run_coverage_python(work_dir, roost, resolution=resolution)
        elif stage in ("resistance", "current"):
            if not roost:
                raise ValueError("No roost defined — place a roost on the map before running the pipeline.")
            with _lock:
                if job_id in _jobs:
                    _jobs[job_id]["progress_label"] = "Computing resistance maps..."
            layers, warnings = _run_r_pipeline(work_dir, stage, roost, features, lamps, params, _job_id=job_id)
        else:
            raise ValueError(f"Unknown pipeline stage: {stage}")

        elapsed = time.monotonic() - t0
        with _lock:
            if job_id in _jobs and _jobs[job_id].get("status") != "cancelled":
                _jobs[job_id]["status"] = "completed"
                _jobs[job_id]["progress"] = 1.0
                _jobs[job_id]["progress_label"] = "Done"
                _jobs[job_id]["layers"] = layers
                _jobs[job_id]["warnings"] = warnings

        logger.info("Job %s: completed in %.1fs, %d layers, %d warnings",
                     job_id, elapsed, len(layers), len(warnings))

    except Exception as e:
        friendly = _sanitize_error(str(e))
        _set_error(job_id, friendly)


def _set_error(job_id: str, message: str):
    logger.error("Job %s failed: %s", job_id, message)
    with _lock:
        if job_id in _jobs:
            _jobs[job_id]["status"] = "failed"
            _jobs[job_id]["error"] = message


@router.post("/coverage", response_model=PipelineStartResponse)
async def start_coverage(req: PipelineRequest):
    logger.info("POST /api/pipeline/coverage (roost=%s, features=%d, lamps=%d)",
                "set" if req.roost else "none", len(req.features), len(req.lamps))
    return _start_pipeline("coverage", req)


@router.post("/resistance", response_model=PipelineStartResponse)
async def start_resistance(req: PipelineRequest):
    logger.info("POST /api/pipeline/resistance (roost=%s, features=%d, lamps=%d)",
                "set" if req.roost else "none", len(req.features), len(req.lamps))
    return _start_pipeline("resistance", req)


@router.post("/current", response_model=PipelineStartResponse)
async def start_current(req: PipelineRequest):
    logger.info("POST /api/pipeline/current (roost=%s, features=%d, lamps=%d)",
                "set" if req.roost else "none", len(req.features), len(req.lamps))
    return _start_pipeline("current", req)


def _start_pipeline(stage: str, req: PipelineRequest) -> PipelineStartResponse:
    job_id = str(uuid.uuid4()).replace("-", "_")
    work_dir = _create_work_dir(job_id)

    logger.info("Job %s: created work dir %s", job_id, work_dir)

    with _lock:
        _jobs[job_id] = {
            "job_id": job_id,
            "status": "pending",
            "progress": 0.0,
            "progress_label": "Initializing...",
            "error": None,
            "warnings": [],
            "layers": None,
            "stage": stage,
            "work_dir": work_dir,
            "_proc": None,
        }

    roost = req.roost.model_dump() if req.roost else None
    features = [f.model_dump() for f in req.features]
    lamps = [l.model_dump() for l in req.lamps]
    params = dict(req.params)

    thread = threading.Thread(
        target=_run_in_background,
        args=(job_id, work_dir, stage, roost, features, lamps, params),
        daemon=True,
    )
    thread.start()

    return PipelineStartResponse(job_id=job_id)


@router.get("/{job_id}", response_model=JobStatus)
async def get_job_status(job_id: str):
    with _lock:
        job = _jobs.get(job_id)

    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    layers = None
    if job.get("layers"):
        layers = [ResultLayerInfo(**l) for l in job["layers"]]

    status = job["status"]
    if status in ("completed", "failed", "cancelled"):
        logger.debug("Poll for terminal-status job %s (status=%s)", job_id, status)

    return JobStatus(
        job_id=job["job_id"],
        status=status,
        progress=job["progress"],
        progress_label=job.get("progress_label", ""),
        error=job.get("error"),
        warnings=job.get("warnings", []),
        layers=layers,
    )


@router.delete("/{job_id}")
async def cancel_job(job_id: str):
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        job["status"] = "cancelled"
        proc = job.pop("_proc", None)
    if proc is not None:
        try:
            proc.kill()
        except Exception:
            pass
    logger.info("Job %s cancelled", job_id)
    return {"job_id": job_id, "status": "cancelled"}
