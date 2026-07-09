"""Celery tasks for the dispersion pipeline shared by the Celery worker and the API router."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import signal
import subprocess
import time
from typing import Any

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded
from pyproj import Transformer

from config import PIPELINE_TIMEOUT
from services.r_bridge import wgs84_to_bng
from services.raster_service import tif_to_png
from services.analytics import emit_pipeline_complete
from services.r_bridge import _write_input_files as wif, collect_results

logger = logging.getLogger(__name__)

REPO_ROOT = os.environ.get("REPO_ROOT", os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def _terminate_group(proc: subprocess.Popen) -> None:
    """Best-effort termination of a subprocess and any helpers it spawned."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except Exception:
            pass


def _create_work_dir(job_id: str) -> str:
    base = os.environ.get("PIPELINE_WORK_DIR", "/tmp/circuitscape")
    work_dir = os.path.join(base, job_id)
    os.makedirs(work_dir, exist_ok=True)
    os.makedirs(os.path.join(work_dir, "images"), exist_ok=True)
    os.makedirs(os.path.join(work_dir, "circuitscape"), exist_ok=True)
    return work_dir


def _payload_hash(
    stage: str,
    roost: dict[str, Any] | None,
    features: list[dict[str, Any]],
    params: dict[str, int | float],
) -> str:
    """Hash the pipeline payload to derive a cache-friendly work directory name."""
    payload = {"stage": stage, "roost": roost, "features": features, "params": params}
    raw = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _write_input_files(
    work_dir: str,
    roost: dict[str, Any] | None,
    features: list[dict[str, Any]],
    params: dict[str, int | float],
) -> None:

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
        "feature_count": len(features),
    }
    with open(os.path.join(work_dir, "inputs.json"), "w") as f:
        json.dump(input_data, f, indent=2)


def _run_coverage(
    task,
    work_dir: str,
    roost: dict[str, Any],
    features: list[dict[str, Any]],
    params: dict[str, int | float],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Run coverage pipeline via R script and convert TIFs to PNGs."""
    t0 = time.monotonic()

    _run_r_pipeline(task, work_dir, "coverage", roost, features, params)

    layers_raw = collect_results(work_dir)
    coverage_keys = {"dtm", "dsm", "lcm"}
    coverage_found = {l["id"] for l in layers_raw if l["id"] in coverage_keys}
    logger.info("Coverage layers found: %s (expected: %s)", coverage_found, coverage_keys)
    layers_raw = [l for l in layers_raw if l["id"] in coverage_keys]

    colormaps = {"dtm": "terrain", "dsm": "terrain", "lcm": "tab20"}

    easting, northing = wgs84_to_bng(roost["lng"], roost["lat"])
    radius = roost.get("radiusMeters", roost.get("radius_meters", 2500))
    extent_bng = (easting - radius, northing - radius, easting + radius, northing + radius)
    bounds_wgs84 = _bng_to_wgs84(extent_bng)

    layers = []
    for layer in layers_raw:
        tif_path = layer["tif_path"]
        name = layer["id"]
        png_path = os.path.join(work_dir, "images", f"{name}.png")
        tif_to_png(tif_path, png_path, bounds_wgs84, colormap=colormaps.get(name, "magma"))
        layers.append({
            "id": name.upper(),
            "url": f"/api/rasters/{os.path.basename(work_dir)}/{name}.png",
            "bounds": list(bounds_wgs84),
        })

    elapsed = time.monotonic() - t0
    if not layers:
        raise RuntimeError("Coverage pipeline produced no result layers — check database raster data")

    logger.info("Coverage pipeline completed in %.1fs, %d layers", elapsed, len(layers))
    return layers, []


def _bng_to_wgs84(extent_bng: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """Convert BNG extent to WGS84 bounds [west, south, east, north]."""
    transformer = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)
    xmin, ymin, xmax, ymax = extent_bng
    west, south = transformer.transform(xmin, ymin)
    east, north = transformer.transform(xmax, ymax)
    return (west, south, east, north)


def _sanitize_error(message: str) -> str:
    """Replace raw error messages with user-safe ones."""
    lower = message.lower()

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
        "the pipeline took too long",
        "no data is available",
    )
    lower_clean = lower.strip()
    if any(lower_clean.startswith(p) for p in known_safe):
        return message
    return "An internal error occurred. Please try again or contact support."


def _run_r_pipeline(
    task,
    work_dir: str,
    stage: str,
    roost: dict[str, Any] | None,
    features: list[dict[str, Any]],
    params: dict[str, int | float],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Run an R pipeline script via subprocess.

    ``task`` is the bound Celery task instance, used for cancellation checks.
    Returns (layers, warnings).
    """
    t0 = time.monotonic()

    wif(work_dir, roost, features, params)

    r_script_map = {
        "coverage": "scripts/run_coverage_pipeline.R",
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
    proc = None

    def _on_sigterm(signum, frame):
        if proc is not None:
            logger.info("Task received SIGTERM; terminating R process group")
            _terminate_group(proc)

    old_handler = signal.signal(signal.SIGTERM, _on_sigterm)
    try:
        # Run Rscript as its own session leader so cancellation can signal the
        # whole process group (Rscript + any R helpers) cleanly.
        proc = subprocess.Popen(
            ["Rscript", "--no-init-file", script_path, os.path.join(work_dir, "inputs.json")],
            cwd=REPO_ROOT, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,
        )
        # Guard the cancellation race: if revoke arrived between task start and
        # Popen, terminate the group now instead of running to the soft limit.
        # ``is_cancelled`` exists on Request objects in real workers; in eager
        # mode (tests) Context doesn't expose it, so default to "not cancelled".
        is_cancelled = getattr(task.request, "is_cancelled", None)
        if callable(is_cancelled) and is_cancelled():
            logger.info("Task was already cancelled; terminating R process group")
            _terminate_group(proc)
            try:
                proc.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            return [], []

        stdout, stderr = proc.communicate(timeout=PIPELINE_TIMEOUT - 60)
    except FileNotFoundError:
        raise RuntimeError(
            "R environment not configured. Resistance and Current pipelines require R. "
            "Only Coverage is available in this deployment."
        )
    except subprocess.TimeoutExpired:
        _terminate_group(proc)
        try:
            proc.communicate()
        except Exception:
            pass
        raise RuntimeError(
            "The pipeline took too long to complete. Try a smaller study area or a higher resolution value."
        )
    finally:
        signal.signal(signal.SIGTERM, old_handler)

    warnings = re.findall(r'WARN\s+\[.*?\]\s+(.*)', stderr or "")

    if proc.returncode != 0:
        is_cancelled = getattr(task.request, "is_cancelled", None)
        if callable(is_cancelled) and is_cancelled():
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

    plot_script = os.path.join(REPO_ROOT, "test", "plot_outputs.R")
    if os.path.exists(plot_script):
        logger.info("Generating diagnostic plots...")
        subprocess.run(
            ["Rscript", "--no-init-file", plot_script, work_dir],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=120,
        )

    result_layers = []
    for layer in layers_raw:
        tif_path = layer["tif_path"]
        from services.raster_service import get_bounds_for_tif
        bounds = get_bounds_for_tif(tif_path)
        result_layers.append({
            "id": layer["name"],
            "url": f"/api/rasters/{os.path.basename(work_dir)}/{layer['id']}.png",
            "bounds": list(bounds),
        })

    elapsed = time.monotonic() - t0
    logger.info("R pipeline completed in %.1fs, %d layers, %d warnings", elapsed, len(result_layers), len(warnings))
    return result_layers, warnings


@shared_task(bind=True, name="tasks.run_pipeline")
def run_pipeline_task(
    self,
    stage: str,
    work_dir: str,
    roost: dict[str, Any] | None,
    features: list[dict[str, Any]],
    params: dict[str, int | float],
) -> dict[str, Any]:
    """Execute a pipeline stage and return its result layers + warnings."""
    t0 = time.monotonic()
    resolution = params.get("resolution", 10)
    logger.info("Job %s: starting %s pipeline (resolution=%.0f, roost=%s, features=%d)",
                self.request.id, stage, resolution,
                f"({roost['lng']:.4f},{roost['lat']:.4f} r={roost.get('radiusMeters',2500)})" if roost else "none",
                len(features))

    def _progress(label: str) -> None:
        self.update_state(state="PROGRESS", meta={"label": label})

    try:
        _progress(f"Running {stage} pipeline...")

        if stage == "coverage":
            if not roost:
                raise ValueError("No roost defined: place a roost on the map before running coverage.")
            _progress("Fetching coverage data...")
            layers, warnings = _run_coverage(self, work_dir, roost, features, params)
        elif stage == "resistance":
            if not roost:
                raise ValueError("No roost defined: place a roost on the map before running the pipeline.")
            _progress("Computing resistance maps...")
            layers, warnings = _run_r_pipeline(self, work_dir, stage, roost, features, params)
        elif stage == "current":
            if not roost:
                raise ValueError("No roost defined: place a roost on the map before running the pipeline.")
            asc_path = os.path.join(work_dir, "circuitscape", "ground.asc")
            if not os.path.exists(asc_path):
                _progress("Computing resistance maps...")
                logger.info("Job %s: ASC files missing, running resistance pipeline first", self.request.id)
                _run_r_pipeline(self, work_dir, "resistance", roost, features, params)
            _progress("Running Circuitscape current map...")
            layers, warnings = _run_r_pipeline(self, work_dir, stage, roost, features, params)
        else:
            raise ValueError(f"Unknown pipeline stage: {stage}")

        elapsed = time.monotonic() - t0
        logger.info("Job %s: completed in %.1fs, %d layers, %d warnings",
                    self.request.id, elapsed, len(layers), len(warnings))
        emit_pipeline_complete(stage, elapsed, True)
        return {"layers": layers, "warnings": warnings}

    except SoftTimeLimitExceeded:
        emit_pipeline_complete(stage, time.monotonic() - t0, False)
        raise RuntimeError(
            "The pipeline took too long to complete. Try a smaller study area or a higher resolution value."
        )
    except Exception as e:
        emit_pipeline_complete(stage, time.monotonic() - t0, False)
        friendly = _sanitize_error(str(e))
        logger.error("Job %s failed: %s", self.request.id, friendly)
        # Celery surfaces the exception's args as result on FAILURE; raise a
        # RuntimeError with the friendly message so it round-trips cleanly.
        raise RuntimeError(friendly) from e


@shared_task(name="tasks.cleanup_work_dirs")
def cleanup_work_dirs() -> None:
    """Periodic task: prune work directories older than the TTL. Scheduled by celery-beat."""
    import shutil as _shutil

    base = os.environ.get("PIPELINE_WORK_DIR", "/tmp/circuitscape")
    ttl_hours = float(os.environ.get("PIPELINE_WORK_DIR_TTL_HOURS", "24"))
    if not os.path.isdir(base):
        return

    cutoff = time.time() - ttl_hours * 3600
    for name in os.listdir(base):
        path = os.path.join(base, name)
        if not os.path.isdir(path):
            continue
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        if mtime < cutoff:
            logger.info("cleanup_work_dirs: removing %s (age %.1fh)", name, (time.time() - mtime) / 3600)
            _shutil.rmtree(path, ignore_errors=True)