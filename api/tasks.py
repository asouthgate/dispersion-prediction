"""Celery tasks for the dispersion pipeline shared by the Celery worker and the API router."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import signal
import shutil as _shutil
import subprocess
import threading
import time
from typing import Any

import redis as _sync_redis
from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded
from pyproj import Transformer

import base64
import rasterio
from rasterio.transform import from_bounds
import numpy as np


from config import PIPELINE_TIMEOUT, AUTH_REDIS_URL, RES_CACHE_TTL_SECONDS
from services.analytics import emit_pipeline_complete
from services.data_fetch import fetch_resistance_inputs
from services.r_bridge import _write_input_files as wif, collect_results, collect_raster_info, wgs84_to_bng
from services.raster_service import get_bounds_for_tif, tif_to_png

logger = logging.getLogger(__name__)

REPO_ROOT = os.environ.get("REPO_ROOT", os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


# We don't rely on these, they are only here as super safety check
_log_redact_re = re.compile(
    r'(?:PGPASSWORD|password|pass(?:wd)?)=\S+',
    re.IGNORECASE,
)

_log_redact_url_re = re.compile(
    r'postgres(?:ql)?://[^\s]+',
    re.IGNORECASE,
)


def _log_redact(msg: str) -> str:
    # Don't rely on this just for triple safety
    msg = _log_redact_re.sub('_____', msg)
    msg = _log_redact_url_re.sub('_____', msg)
    return msg


def _try_parse_log_line(line: str) -> str | None:
    stripped = line.rstrip("\n\r")
    if not stripped:
        return None
    try:
        msg = json.loads(stripped)
    except json.JSONDecodeError:
        return None
    if not msg.get("user_visible"):
        return None
    level = msg.get("level", "info")
    text = str(msg.get("msg", ""))
    text = _log_redact(text)
    if level == "warn" or level == "error":
        return f"stderr:{level.upper()}: {text}"
    else:
        return text


def _terminate_group(proc: subprocess.Popen) -> None:
    """Attempt to terminate of a subprocess and any helpers it spawned."""
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


def _payload_hash_ns(
    roost: dict[str, Any] | None,
    features: list[dict[str, Any]],
    params: dict[str, int | float],
) -> str:
    """Hash for cross-stage cache lookups (resistance -> current)."""
    payload = {"roost": roost, "features": features, "params": params}
    raw = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _touch_res_cache(res_hash: str) -> None:
    """Extend the TTL of cached resistance results so they survive a long-running Current stage."""
    try:
        r = _sync_redis.Redis.from_url(AUTH_REDIS_URL, decode_responses=True)
        key = f"pipeline:res_cache:{res_hash}"
        r.expire(key, RES_CACHE_TTL_SECONDS)
        r.close()
    except Exception:
        pass


def _store_resistance_cache(
    roost: dict[str, Any],
    features: list[dict[str, Any]],
    params: dict[str, int | float],
    work_dir: str,
) -> None:
    """Store a Redis pointer to completed resistance results for reuse by Current."""
    res_hash = _payload_hash_ns(roost, features, params)
    try:
        r = _sync_redis.Redis.from_url(AUTH_REDIS_URL, decode_responses=True)
        r.set(f"pipeline:res_cache:{res_hash}", work_dir, ex=RES_CACHE_TTL_SECONDS)
        r.close()
        logger.info("Stored resistance cache: hash=%s work_dir=%s", res_hash, work_dir)
    except Exception as e:
        logger.warning("Failed to store resistance cache: %s", e)


def _try_reuse_resistance_cache(
    roost: dict[str, Any],
    features: list[dict[str, Any]],
    params: dict[str, int | float],
    work_dir: str,
) -> bool:
    """Attempt to reuse cached resistance ASC files from a previous Resistance run.

    Looks up the stage-agnostic payload hash in Redis and copies the
    circuitscape directory if found and still valid.  Refreshes the TTL
    first so that long-running Current stages don't lose the cache mid-run.
    Returns True if the cache was reused, False otherwise.
    """
    res_hash = _payload_hash_ns(roost, features, params)
    try:
        r = _sync_redis.Redis.from_url(AUTH_REDIS_URL, decode_responses=True)
        cached_dir = r.get(f"pipeline:res_cache:{res_hash}")
        r.close()
    except Exception as e:
        logger.warning("Failed to read resistance cache: %s", e)
        return False

    if not cached_dir:
        return False

    src_asc = os.path.join(cached_dir, "circuitscape", "ground.asc")
    if not os.path.exists(src_asc):
        logger.info("Cached resistance work_dir gone, ignoring: %s", cached_dir)
        return False

    _touch_res_cache(res_hash)
    logger.info("Reusing cached resistance from %s → %s", cached_dir, work_dir)
    dst_dir = os.path.join(work_dir, "circuitscape")
    os.makedirs(dst_dir, exist_ok=True)
    for fname in os.listdir(os.path.join(cached_dir, "circuitscape")):
        src = os.path.join(cached_dir, "circuitscape", fname)
        dst = os.path.join(dst_dir, fname)
        if os.path.isfile(src) and not os.path.exists(dst):
            _shutil.copy2(src, dst)
    return True


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
        layer_id = layer["id"]
        name = layer["name"]
        png_path = os.path.join(work_dir, "images", f"{layer_id}.png")
        tif_to_png(tif_path, png_path, bounds_wgs84, colormap=colormaps.get(layer_id, "magma"),
                   circular_mask=False)
        layers.append({
            "id": layer_id,
            "name": name,
            "url": f"/api/rasters/{task.request.id}/{layer_id}.png",
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
    if "failed to fetch" in lower and "raster" in lower:
        return "Unable to retrieve spatial data for the selected area. Try a different location."
    known_safe = (
        "no roost defined",
        "unknown pipeline stage",
        "the pipeline took too long",
        "no data is available",
        "no data is available for the selected area",
    )
    lower_clean = lower.strip()
    if any(lower_clean.startswith(p) for p in known_safe):
        return message
    return "An internal error occurred. Please try again or contact support."


def _apply_georeferencing(work_dir: str) -> None:
    """Apply georeferencing from grid_info.json to TIFFs that lack it.

    The Rust binary writes GeoTIFFs via the raw `tiff` crate which does not
    embed geo-keys.  We read grid_info.json (written by data_fetch.py) and
    rewrite every .tif in work_dir that has a default (0,0)-origin transform
    with the correct georeferencing.
    """

    gi_path = os.path.join(work_dir, "grid_info.json")
    if not os.path.exists(gi_path):
        logger.debug("No grid_info.json in %s — skipping georeferencing fix", work_dir)
        return


    with open(gi_path) as f:
        gi = json.load(f)


    ref_transform = from_bounds(
        gi["xmin"],
        gi["ymax"] - gi["nrows"] * gi["pixw"],
        gi["xmin"] + gi["ncols"] * gi["pixw"],
        gi["ymax"],
        gi["ncols"],
        gi["nrows"],
    )

    fixed = 0
    for fname in sorted(os.listdir(work_dir)):
        if not fname.endswith(".tif"):
            continue
        path = os.path.join(work_dir, fname)
        try:
            with rasterio.open(path) as src:
                if src.transform.c != 0.0 or src.transform.f != 0.0:
                    continue
                data = src.read(1)
                dtype = src.dtypes[0]
        except Exception:
            continue

        tmp_path = path + ".geofix"
        try:
            with rasterio.open(
                tmp_path,
                "w",
                driver="GTiff",
                height=gi["nrows"],
                width=gi["ncols"],
                count=1,
                dtype=dtype,
                crs="EPSG:27700",
                transform=ref_transform,
                nodata=-9999.0,
            ) as dst:
                dst.write(data, 1)
            os.replace(tmp_path, path)
            fixed += 1
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise

    if fixed:
        logger.info(
            "Applied georeferencing to %d GeoTIFF(s) in %s (grid %dx%d, xmin=%.2f, ymax=%.2f, pixw=%.2f)",
            fixed,
            work_dir,
            gi["nrows"],
            gi["ncols"],
            gi["xmin"],
            gi["ymax"],
            gi["pixw"],
        )


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
        "coverage": "scripts/run-coverage-pipeline.R",
        "current": "scripts/run-circuitscape.R",
    }
    binary_map = {
        "resistance": "resistance-pipeline",
    }

    use_binary = stage in binary_map
    if use_binary:
        binary_path = _shutil.which(binary_map[stage])
        if not binary_path:
            raise RuntimeError(f"Binary not found: {binary_map[stage]}")
        logger.info("Fetching DB data for landscape resistance...")
        from services.data_fetch import fetch_landscape_inputs
        fetch_landscape_inputs(work_dir)
        cmd = [binary_path, work_dir, "--stage", "landscape"]
        cwd = work_dir
        env = os.environ.copy()
    else:
        rscript = r_script_map.get(stage)
        if not rscript:
            raise ValueError(f"Unknown stage: {stage}")
        script_path = os.path.join(REPO_ROOT, rscript)
        if not os.path.exists(script_path):
            raise FileNotFoundError(f"R script not found: {rscript}")
        cmd = ["Rscript", "--no-init-file", script_path, os.path.join(work_dir, "inputs.json")]
        cwd = REPO_ROOT
        env = os.environ.copy()
        env["R_PIPELINE_WORKDIR"] = work_dir

    logger.info("Running pipeline: stage=%s cmd=%s", stage, cmd[0])
    proc = None
    task_id = task.request.id

    def _on_sigterm(signum, frame):
        if proc is not None:
            logger.info("Task received SIGTERM; terminating process group")
            _terminate_group(proc)

    old_handler = signal.signal(signal.SIGTERM, _on_sigterm)
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,
        )
        # Guard the cancellation race
        is_cancelled = getattr(task.request, "is_cancelled", None)
        if callable(is_cancelled) and is_cancelled():
            logger.info("Task was already cancelled; terminating process group")
            _terminate_group(proc)
            try:
                proc.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            return [], []

        stdout_lines: list[str] = []
        stderr_lines: list[str] = []

        def _read_and_pipe(stream, capture_list: list[str], prefix: str) -> None:
            r_sync = None
            try:
                r_sync = _sync_redis.Redis.from_url(AUTH_REDIS_URL, decode_responses=True)
                log_key = f"pipeline:logs:{task_id}"
                for line in iter(stream.readline, ""):
                    capture_list.append(line)
                    text = _try_parse_log_line(line)
                    if text is not None:
                        r_sync.rpush(log_key, text)
                r_sync.expire(log_key, PIPELINE_TIMEOUT * 2)
            except Exception:
                pass
            finally:
                try:
                    if r_sync:
                        r_sync.close()
                except Exception:
                    pass

        t_out = threading.Thread(target=_read_and_pipe, args=(proc.stdout, stdout_lines, ""), daemon=True)
        t_err = threading.Thread(target=_read_and_pipe, args=(proc.stderr, stderr_lines, "stderr:"), daemon=True)
        t_out.start()
        t_err.start()

        try:
            proc.wait(timeout=PIPELINE_TIMEOUT - 60)
        except subprocess.TimeoutExpired:
            _terminate_group(proc)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            raise RuntimeError(
                "The pipeline took too long to complete. Try a smaller study area or a higher resolution value."
            )

        t_out.join(timeout=10)
        t_err.join(timeout=10)

        stdout = "".join(stdout_lines)
        stderr = "".join(stderr_lines)
    except FileNotFoundError:
        if use_binary:
            raise RuntimeError(
                f"Pipeline binary not found: {binary_map[stage]}. "
                "Resistance pipeline requires the Rust binary."
            )
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
            logger.info("Pipeline was cancelled (rc=%d), not treating as error", proc.returncode)
            return [], warnings
        stderr_tail = (stderr or "")[-500:] or "(no output)"
        logger.error("Pipeline failed (rc=%d): %s", proc.returncode, stderr_tail)
        raise RuntimeError(f"Pipeline failed (rc={proc.returncode}): {stderr_tail[:300]}")

    if use_binary:
        lcm_path = os.path.join(work_dir, "lcm.tif")
        if os.path.exists(lcm_path):
            os.unlink(lcm_path)
            logger.info("Removed lcm.tif — LCM stays server-side")
        _apply_georeferencing(work_dir)

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
    for layer in layers_raw:
        tif_path = layer["tif_path"]
        png_path = os.path.join(work_dir, "images", f"{layer['id']}.png")
        colormap = "plasma" if "current" in layer["id"] else "magma"
        try:
            bounds = get_bounds_for_tif(tif_path)
            tif_to_png(tif_path, png_path, bounds, colormap=colormap,
                       circular_mask=("current" in layer["id"]))
        except Exception as e:
            logger.warning("Pre-render failed for %s: %s", layer["id"], e)

    result_layers = []
    for layer in layers_raw:
        tif_path = layer["tif_path"]
        bounds = get_bounds_for_tif(tif_path)
        result_layers.append({
            "id": layer["id"],
            "name": layer["name"],
            "url": f"/api/rasters/{task.request.id}/{layer['id']}.png",
            "bounds": list(bounds),
        })

    elapsed = time.monotonic() - t0
    logger.info("R pipeline completed in %.1fs, %d layers, %d warnings", elapsed, len(result_layers), len(warnings))
    return result_layers, warnings


def _cleanup_token_job(task_id: str, success: bool) -> None:
    """Clear per-token job keys and the in-flight marker for a finished task.

    On failure the dedup key is also cleared so a retry of the same payload
    starts a fresh job instead of being handed back the failed one.
    """
    try:
        r = _sync_redis.Redis.from_url(AUTH_REDIS_URL, decode_responses=True)
        token = r.get(f"job:token:{task_id}")
        if token:
            r.delete(f"job:by_token:{token}", f"job:token:{task_id}")
        r.srem("jobs:inflight", task_id)
        if not success:
            h = r.get(f"task_to_hash:{task_id}")
            if h:
                r.delete(f"dedup:{h}", f"task_to_hash:{task_id}")
        r.close()
    except Exception:
        pass

def _write_total_resistance_raster(work_dir: str, total_res: dict[str, Any], roost: dict[str, Any]) -> None:
    """Decode browser-computed total resistance and write as GeoTIFF + ASC files.

    Also writes ground.asc (roost point) and source.asc (roost disk) required
    by Circuitscape, so the server does not fall back to server-side resistance.
    """

    extent = total_res["extent"]
    m = extent["m"]
    n = extent["n"]
    pixw = extent["pixw"]
    xmin = extent["xmin"]
    ymin = extent["ymin"]
    xmax = extent["xmax"]
    ymax = extent["ymax"]
    raw = base64.b64decode(total_res["data_base64"])
    arr = np.frombuffer(raw, dtype="<f4").reshape((m, n))

    tif_path = os.path.join(work_dir, "total_res.tif")
    transform = from_bounds(xmin, ymin, xmax, ymax, n, m)
    with rasterio.open(
        tif_path, "w", driver="GTiff", height=m, width=n, count=1,
        dtype="float32", crs="EPSG:27700", transform=transform,
    ) as dst:
        dst.write_band(1, arr)

    circuitscape_dir = os.path.join(work_dir, "circuitscape")
    os.makedirs(circuitscape_dir, exist_ok=True)

    asc_path = os.path.join(circuitscape_dir, "resistance.asc")
    with open(asc_path, "w") as f:
        f.write(f"ncols         {n}\n")
        f.write(f"nrows         {m}\n")
        f.write(f"xllcorner     {xmin}\n")
        f.write(f"yllcorner     {ymin}\n")
        f.write(f"cellsize      {pixw}\n")
        f.write(f"NODATA_value  -9999\n")
        np.savetxt(f, arr, fmt="%.6f", delimiter=" ")

    logger.info("Wrote browser-computed total resistance (%dx%d) to %s", m, n, asc_path)

    roost_e, roost_n = wgs84_to_bng(roost["lng"], roost["lat"])
    radius = float(roost.get("radiusMeters", 2500.0))

    roost_col = int((roost_e - xmin) / pixw)
    roost_row = int((ymax - roost_n) / pixw)

    ground = np.zeros((m, n), dtype=np.float32)
    if 0 <= roost_row < m and 0 <= roost_col < n:
        ground[roost_row, roost_col] = 1.0

    ground_path = os.path.join(circuitscape_dir, "ground.asc")
    with open(ground_path, "w") as f:
        f.write(f"ncols         {n}\n")
        f.write(f"nrows         {m}\n")
        f.write(f"xllcorner     {xmin}\n")
        f.write(f"yllcorner     {ymin}\n")
        f.write(f"cellsize      {pixw}\n")
        f.write(f"NODATA_value  -9999\n")
        np.savetxt(f, ground, fmt="%.0f", delimiter=" ")

    ys = np.arange(m, dtype=np.float64) * pixw + ymin + pixw * 0.5
    xs = np.arange(n, dtype=np.float64) * pixw + xmin + pixw * 0.5
    xx, yy = np.meshgrid(xs, ys)
    dist = np.sqrt((xx - roost_e) ** 2 + (yy - roost_n) ** 2)
    source = np.where(dist <= radius, 1.0, 0.0).astype(np.float32)

    source_path = os.path.join(circuitscape_dir, "source.asc")
    with open(source_path, "w") as f:
        f.write(f"ncols         {n}\n")
        f.write(f"nrows         {m}\n")
        f.write(f"xllcorner     {xmin}\n")
        f.write(f"yllcorner     {ymin}\n")
        f.write(f"cellsize      {pixw}\n")
        f.write(f"NODATA_value  -9999\n")
        np.savetxt(f, source, fmt="%.0f", delimiter=" ")

    logger.info("Wrote ground.asc (roost at %d,%d) and source.asc (radius=%.0fm)", roost_col, roost_row, radius)

@shared_task(bind=True, name="tasks.run_pipeline")
def run_pipeline_task(
    self,
    stage: str,
    work_dir: str,
    roost: dict[str, Any] | None,
    features: list[dict[str, Any]],
    params: dict[str, int | float],
    total_resistance: dict[str, Any] | None = None,
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

    success = False
    try:
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
                _store_resistance_cache(roost, features, params, work_dir)

                raw_tifs = {}
                for layer in layers:
                    lid = layer["id"]
                    raw_tifs[lid] = f"/api/rasters/{self.request.id}/raw/{lid}.tif"
                cond_path = os.path.join(work_dir, "landscape_conductance.tif")
                if os.path.exists(cond_path):
                    raw_tifs["landscape_conductance"] = f"/api/rasters/{self.request.id}/raw/landscape_conductance.tif"
                raster_extent = collect_raster_info(work_dir)

                layers = [l for l in layers if l["id"] != "landscape_conductance"]

                raw_geojson = {}
                for gj_name in ("roads", "rivers", "buildings", "generic_resistance"):
                    gj_path = os.path.join(work_dir, f"{gj_name}.geojson")
                    if os.path.exists(gj_path):
                        raw_geojson[gj_name] = f"/api/rasters/{self.request.id}/raw/{gj_name}.geojson"

                logger.info(
                    "Job %s: raster_extent=%s, raw_tifs=%s, raw_geojson=%s",
                    self.request.id, raster_extent,
                    list(raw_tifs.keys()), list(raw_geojson.keys()),
                )
            elif stage == "current":
                if not roost:
                    raise ValueError("No roost defined: place a roost on the map before running the pipeline.")
                if total_resistance:
                    _progress("Writing browser-computed total resistance...")
                    _write_total_resistance_raster(work_dir, total_resistance, roost)
                asc_path = os.path.join(work_dir, "circuitscape", "ground.asc")
                if not os.path.exists(asc_path):
                    _progress("Checking for cached resistance results...")
                    if not _try_reuse_resistance_cache(roost, features, params, work_dir):
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
            success = True
            result = {"layers": layers, "warnings": warnings}
            if stage == "resistance":
                result["raw_tifs"] = raw_tifs
                result["raster_extent"] = raster_extent
                result["raw_geojson"] = raw_geojson
            return result

        except SoftTimeLimitExceeded:
            emit_pipeline_complete(stage, time.monotonic() - t0, False)
            raise RuntimeError(
                "The pipeline took too long to complete. Try a smaller study area or a higher resolution value."
            )
        except Exception as e:
            emit_pipeline_complete(stage, time.monotonic() - t0, False)
            friendly = _sanitize_error(str(e))
            logger.error("Job %s failed: %s", self.request.id, friendly)
            raise RuntimeError(friendly) from e
    finally:
        _cleanup_token_job(self.request.id, success)


@shared_task(name="tasks.cleanup_work_dirs")
def cleanup_work_dirs() -> None:
    """Periodic task: prune work directories older than the TTL. Scheduled by celery-beat."""

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


@shared_task(name="tasks.prune_umami_events")
def prune_umami_events() -> None:
    """Daily (celery-beat): delete Umami analytics rows older than
    UMAMI_RETENTION_DAYS. Umami has no built-in retention, so without this
    its postgres volume grows forever.

    Only runs when UMAMI_DATABASE_URL is set. Targets the Umami v2 schema
    (event_data -> event -> session, children first). A schema mismatch just
    logs a warning and tries again tomorrow.
    """
    db_url = os.environ.get("UMAMI_DATABASE_URL", "")
    if not db_url:
        return
    days = int(os.environ.get("UMAMI_RETENTION_DAYS", "180"))

    import psycopg2

    try:
        conn = psycopg2.connect(db_url)
    except Exception as e:
        logger.warning("prune_umami_events: cannot connect to Umami DB: %s", e)
        return

    try:
        with conn.cursor() as cur:
            deleted = {}
            for table in ("event_data", "event", "session"):
                cur.execute(
                    f"DELETE FROM {table} WHERE created_at < now() - make_interval(days => %s)",
                    (days,),
                )
                deleted[table] = cur.rowcount
        conn.commit()
        logger.info(
            "prune_umami_events: deleted %s rows older than %d days",
            deleted, days,
        )
    except Exception as e:
        conn.rollback()
        logger.warning("prune_umami_events failed: %s", e)
    finally:
        conn.close()
