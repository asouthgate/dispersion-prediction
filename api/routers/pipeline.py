"""Pipeline router: handles job submission/management via Celery."""

from __future__ import annotations

import logging
import os
import uuid

from celery.result import AsyncResult
from fastapi import APIRouter, Depends, HTTPException, status
from redis import Redis

from celery_app import celery_app
from middleware.auth import require_auth
from schemas.pipeline import (
    PipelineRequest,
    PipelineStartResponse,
    JobStatus,
    ResultLayerInfo,
)
from tasks import run_pipeline_task, _payload_hash, _create_work_dir

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pipeline", tags=["pipeline"])

# In order to cache temporally close identical requests, we use a
# Deduplication cache in Redis. Works for multiple users.
# Dedup cache: payload_hash -> task_id, with a TTL that exceeds the longest
# task. Worst case on Redis restart: two identical rapid requests both run.
_redis: Redis | None = None
DEDUP_TTL_SECONDS = 3600


def _dedup_client() -> Redis:
    global _redis
    if _redis is None:
        _redis = Redis.from_url(
            os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/0"),
            decode_responses=True,
        )
    return _redis


# Map Celery states to client statuses.
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
    return _start_pipeline("coverage", req, token)


@router.post("/resistance", response_model=PipelineStartResponse)
async def start_resistance(req: PipelineRequest, token: str = Depends(require_auth)):
    logger.info("POST /api/pipeline/resistance (roost=%s, features=%d)",
                "set" if req.roost else "none", len(req.features))
    return _start_pipeline("resistance", req, token)


@router.post("/current", response_model=PipelineStartResponse)
async def start_current(req: PipelineRequest, token: str = Depends(require_auth)):
    logger.info("POST /api/pipeline/current (roost=%s, features=%d)",
                "set" if req.roost else "none", len(req.features))
    return _start_pipeline("current", req, token)


def _start_pipeline(stage: str, req: PipelineRequest, token: str) -> PipelineStartResponse:
    roost = req.roost.model_dump() if req.roost else None
    features = [f.model_dump() for f in req.features]
    params = dict(req.params)

    payload_hash = _payload_hash(stage, roost, features, params)
    work_dir = _create_work_dir(payload_hash)

    # Dedup: an identical in-flight payload returns the existing task id.
    # SET NX EX is atomic; first writer wins. TTL >= longest task.
    dedup_key = f"dedup:{payload_hash}"
    try:
        existing = _dedup_client().get(dedup_key)
    except Exception:
        existing = None
    if existing:
        logger.info("Reusing in-flight job %s (hash=%s) for new %s request",
                    existing, payload_hash, stage)
        return PipelineStartResponse(job_id=existing)

    task_id = uuid.uuid4().hex
    logger.info("Job %s: work dir %s (hash=%s)", task_id, work_dir, payload_hash)

    try:
        _dedup_client().set(dedup_key, task_id, ex=DEDUP_TTL_SECONDS, nx=True)
        reverse_key = f"task_to_hash:{task_id}"
        _dedup_client().set(reverse_key, payload_hash, ex=DEDUP_TTL_SECONDS)
        _dedup_client().set(f"job:owner:{task_id}", token, ex=DEDUP_TTL_SECONDS)

    except Exception as e:
        logger.error("Failed to write dedup keys to Redis: %s", e)
        pass

    run_pipeline_task.apply_async(
        args=(stage, work_dir, roost, features, params),
        task_id=task_id,
    )

    return PipelineStartResponse(job_id=task_id)


@router.get("/{job_id}", response_model=JobStatus)
async def get_job_status(job_id: str):
    result = AsyncResult(job_id, app=celery_app)
    state = result.state
    status = _STATE_MAP.get(state, "pending")

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
        # result.result holds the exception; Celery may store it as the repr
        # or the exception instance depending on configuration.
        err = result.result
        if isinstance(err, Exception):
            error = str(err.args[0]) if err.args else str(err)
        elif err is not None:
            error = str(err)
        else:
            error = "An internal error occurred. Please try again or contact support."
    elif state == "REVOKED":
        progress_label = "Cancelled"

    if status in ("completed", "failed", "cancelled"):
        logger.debug("Poll for terminal-status job %s (state=%s)", job_id, state)

    return JobStatus(
        job_id=job_id,
        status=status,
        progress=1.0 if status == "completed" else 0.0,
        progress_label=progress_label,
        error=error,
        warnings=warnings,
        layers=layers,
    )


@router.delete("/{job_id}")
async def cancel_job(job_id: str, token: str = Depends(require_auth), redis: Redis = Depends(_dedup_client)):
    owner = redis.get(f"job:owner:{job_id}")
    if owner and owner != token:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only cancel your own jobs",
        )

    celery_app.control.revoke(job_id, terminate=True, signal="SIGTERM")

    reverse_key = f"task_to_hash:{job_id}"
    payload_hash = redis.get(reverse_key)
    if payload_hash:
        redis.delete(f"dedup:{payload_hash}")
        redis.delete(reverse_key)
        redis.delete(f"job:owner:{job_id}")

    logger.info("Job %s cancelled and dedup cleared", job_id)
    return {"job_id": job_id, "status": "cancelled"}