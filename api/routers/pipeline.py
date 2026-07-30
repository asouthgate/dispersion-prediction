"""Pipeline router: handles job submission/management via Celery."""

from __future__ import annotations

import logging
import uuid

from celery.result import AsyncResult
from fastapi import APIRouter, Depends, HTTPException, status

from celery_app import celery_app
from config import MAX_PIXEL_DIMENSION, PIPELINE_TIMEOUT, MAX_INFLIGHT_JOBS
from middleware.auth import require_auth
from schemas.pipeline import (
    PipelineRequest,
    PipelineStartResponse,
    JobStatus,
    ResultLayerInfo,
)
from services.analytics import daily_token_hash, emit_pipeline_submit
from services.redis import get_redis
from tasks import run_pipeline_task, _payload_hash, _create_work_dir

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pipeline", tags=["pipeline"])

# Dedup cache lifetime. Must cover the lifetime of the hash-named work dir
# (results are served via task_to_hash for 24h); a shorter dedup TTL lets a
# resubmitted identical payload recycle the same work dir while earlier
# tasks still reference it. Failed jobs clear their dedup key on completion
# (see tasks._cleanup_token_job) so retries are never stuck on a dead job.
DEDUP_TTL_SECONDS = 86400
TASK_HASH_TTL_SECONDS = 86400
PIPELINE_TIMEOUT_SAFETY = PIPELINE_TIMEOUT * 2


_STATE_MAP = {
    "PENDING": "pending",
    "STARTED": "running",
    "RETRY": "running",
    "PROGRESS": "running",
    "SUCCESS": "completed",
    "FAILURE": "failed",
    "REVOKED": "cancelled",
}


@router.post("/coverage", response_model=PipelineStartResponse)
async def start_coverage(req: PipelineRequest, token: str = Depends(require_auth)):
    logger.info("POST /api/pipeline/coverage (roost=%s, features=%d)",
                "set" if req.roost else "none", len(req.features))
    return await _start_pipeline("coverage", req, token)


@router.post("/resistance", response_model=PipelineStartResponse)
async def start_resistance(req: PipelineRequest, token: str = Depends(require_auth)):
    logger.info("POST /api/pipeline/resistance (roost=%s, features=%d)",
                "set" if req.roost else "none", len(req.features))
    return await _start_pipeline("resistance", req, token)


@router.post("/current", response_model=PipelineStartResponse)
async def start_current(req: PipelineRequest, token: str = Depends(require_auth)):
    logger.info("POST /api/pipeline/current (roost=%s, features=%d)",
                "set" if req.roost else "none", len(req.features))
    return await _start_pipeline("current", req, token)


async def _add_viewer(redis, job_id: str, token: str) -> None:
    """Grant a non-owner token read access to a deduplicated job's status."""
    try:
        await redis.sadd(f"job:viewers:{job_id}", token)
        await redis.expire(f"job:viewers:{job_id}", TASK_HASH_TTL_SECONDS)
    except Exception as e:
        logger.warning("Failed to add viewer for job %s: %s", job_id, e)


async def _start_pipeline(stage: str, req: PipelineRequest, token: str) -> PipelineStartResponse:
    roost = req.roost.model_dump() if req.roost else None
    features = [f.model_dump() for f in req.features]
    params = dict(req.params)

    if roost:
        radius = roost.get("radiusMeters") or roost.get("radius_meters", 2500)
        resolution = params.get("resolution", 10)
        pixel_dim = (2 * radius) / resolution
        if pixel_dim > MAX_PIXEL_DIMENSION:
            min_res = -(-int(2 * radius) // MAX_PIXEL_DIMENSION)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Resolution too high for the selected area. Use a resolution of at least {min_res} m/px or reduce the study area.",
            )

    redis = get_redis()

    existing_job = None
    try:
        existing_job = await redis.get(f"job:by_token:{token}")
    except Exception:
        pass
    if existing_job:
        result = AsyncResult(existing_job, app=celery_app)
        if result.state in ("PENDING", "STARTED", "RETRY", "PROGRESS"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="You already have a running job. Wait for it to complete or cancel it first.",
            )
        else:
            try:
                await redis.delete(f"job:by_token:{token}")
            except Exception:
                pass

    # Global backpressure: cap total in-flight jobs so a burst of fresh
    # tokens can't grow the broker queue without bound. Terminal-state
    # members are pruned lazily when the cap is hit.
    try:
        inflight = await redis.scard("jobs:inflight")
        if inflight is not None and inflight >= MAX_INFLIGHT_JOBS:
            members = await redis.smembers("jobs:inflight")
            for m in members:
                if AsyncResult(m, app=celery_app).state in ("SUCCESS", "FAILURE", "REVOKED"):
                    await redis.srem("jobs:inflight", m)
            inflight = await redis.scard("jobs:inflight")
        if inflight is not None and inflight >= MAX_INFLIGHT_JOBS:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Server is busy. Please try again in a few minutes.",
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("In-flight check failed (allowing request): %s", e)

    payload_hash = _payload_hash(stage, roost, features, params)
    work_dir = _create_work_dir(payload_hash)

    dedup_key = f"dedup:{payload_hash}"
    try:
        existing = await redis.get(dedup_key)
    except Exception:
        existing = None
    if existing:
        logger.info("Reusing in-flight job %s (hash=%s) for new %s request",
                    existing, payload_hash, stage)
        await _add_viewer(redis, existing, token)
        return PipelineStartResponse(job_id=existing)

    task_id = uuid.uuid4().hex
    logger.info("Job %s: work dir %s (hash=%s)", task_id, work_dir, payload_hash)

    try:
        won = await redis.set(dedup_key, task_id, ex=DEDUP_TTL_SECONDS, nx=True)
    except Exception as e:
        logger.error("Failed to write dedup key to Redis: %s", e)
        won = True  # Redis unavailable: proceed without dedup.
    if not won:
        # Lost the race: a concurrent request already dispatched this payload.
        existing = await redis.get(dedup_key)
        if existing:
            logger.info("Concurrent duplicate: returning winner %s (hash=%s)", existing, payload_hash)
            await _add_viewer(redis, existing, token)
            return PipelineStartResponse(job_id=existing)

    try:
        reverse_key = f"task_to_hash:{task_id}"
        await redis.set(reverse_key, payload_hash, ex=TASK_HASH_TTL_SECONDS)
        await redis.set(f"job:owner:{task_id}", token, ex=TASK_HASH_TTL_SECONDS)
        await redis.set(f"job:by_token:{token}", task_id, ex=PIPELINE_TIMEOUT_SAFETY)
        await redis.set(f"job:token:{task_id}", token, ex=PIPELINE_TIMEOUT_SAFETY)
        await redis.sadd("jobs:inflight", task_id)
    except Exception as e:
        logger.error("Failed to write job keys to Redis: %s", e)

    run_pipeline_task.apply_async(
        args=(stage, work_dir, roost, features, params),
        task_id=task_id,
    )

    emit_pipeline_submit(
        stage=stage,
        resolution=params.get("resolution", 10),
        feature_count=len(features),
        has_roost=bool(roost),
        user_id=daily_token_hash(token),
    )

    return PipelineStartResponse(job_id=task_id)


@router.get("/{job_id}", response_model=JobStatus)
async def get_job_status(job_id: str, token: str = Depends(require_auth)):
    redis = get_redis()
    try:
        owner = await redis.get(f"job:owner:{job_id}")
    except Exception:
        owner = None
    if owner is not None and owner != token:
        # A different user may have been handed this job_id by the dedup
        # cache; viewers get read access, everyone else is rejected.
        try:
            is_viewer = await redis.sismember(f"job:viewers:{job_id}", token)
        except Exception:
            is_viewer = False
        if not is_viewer:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can only view your own jobs")

    result = AsyncResult(job_id, app=celery_app)
    state = result.state
    client_status = _STATE_MAP.get(state, "pending")

    progress_label = ""
    error = None
    layers = None
    warnings: list[str] = []

    if state == "PROGRESS" and isinstance(result.info, dict):
        progress_label = result.info.get("label", "")
    elif state == "SUCCESS":
        payload = result.result or {}
        layers_data = payload.get("layers")
        warnings = payload.get("warnings", []) or []
        progress_label = "Done"
        if layers_data:
            layers = [ResultLayerInfo(**layer) for layer in layers_data]
    elif state == "FAILURE":
        err = result.result
        if isinstance(err, Exception):
            error = str(err.args[0]) if err.args else str(err)
        elif err is not None:
            error = str(err)
        else:
            error = "An internal error occurred. Please try again or contact support."
    elif state == "REVOKED":
        progress_label = "Cancelled"

    if client_status in ("completed", "failed", "cancelled"):
        logger.debug("Poll for terminal-status job %s (state=%s)", job_id, state)

    return JobStatus(
        job_id=job_id,
        status=client_status,
        progress=1.0 if client_status == "completed" else 0.0,
        progress_label=progress_label,
        error=error,
        warnings=warnings,
        layers=layers,
    )


@router.delete("/{job_id}")
async def cancel_job(job_id: str, token: str = Depends(require_auth)):
    redis = get_redis()
    try:
        owner = await redis.get(f"job:owner:{job_id}")
    except Exception as e:
        logger.error("Redis error during job owner lookup: %s", e)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Service unavailable")

    if owner is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Job not found",
        )
    if owner != token:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only cancel your own jobs",
        )

    celery_app.control.revoke(job_id, terminate=True, signal="SIGTERM")

    reverse_key = f"task_to_hash:{job_id}"
    payload_hash = await redis.get(reverse_key)
    if payload_hash:
        await redis.delete(f"dedup:{payload_hash}")
        await redis.delete(reverse_key)
    try:
        await redis.delete(f"job:by_token:{token}")
        await redis.delete(f"job:token:{job_id}")
        await redis.srem("jobs:inflight", job_id)
    except Exception:
        pass
    await redis.delete(f"job:owner:{job_id}")

    logger.info("Job %s cancelled and dedup cleared", job_id)
    return {"job_id": job_id, "status": "cancelled"}
