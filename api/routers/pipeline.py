"""Pipeline router: handles job submission/management via Celery."""

from __future__ import annotations

import logging
import uuid

from celery.result import AsyncResult
from fastapi import APIRouter, Depends, HTTPException, status
import redis.asyncio as aioredis

from celery_app import celery_app
from config import AUTH_REDIS_URL
from middleware.auth import require_auth
from schemas.pipeline import (
    PipelineRequest,
    PipelineStartResponse,
    JobStatus,
    ResultLayerInfo,
)
from services.analytics import daily_token_hash, emit_pipeline_submit
from tasks import run_pipeline_task, _payload_hash, _create_work_dir

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pipeline", tags=["pipeline"])

DEDUP_TTL_SECONDS = 3600

_redis: aioredis.Redis | None = None


def _get_dedup_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(AUTH_REDIS_URL, decode_responses=True)
    return _redis


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


async def _start_pipeline(stage: str, req: PipelineRequest, token: str) -> PipelineStartResponse:
    roost = req.roost.model_dump() if req.roost else None
    features = [f.model_dump() for f in req.features]
    params = dict(req.params)

    payload_hash = _payload_hash(stage, roost, features, params)
    work_dir = _create_work_dir(payload_hash)

    redis = _get_dedup_redis()
    dedup_key = f"dedup:{payload_hash}"
    try:
        existing = await redis.get(dedup_key)
    except Exception:
        existing = None
    if existing:
        logger.info("Reusing in-flight job %s (hash=%s) for new %s request",
                    existing, payload_hash, stage)
        return PipelineStartResponse(job_id=existing)

    task_id = uuid.uuid4().hex
    logger.info("Job %s: work dir %s (hash=%s)", task_id, work_dir, payload_hash)

    try:
        await redis.set(dedup_key, task_id, ex=DEDUP_TTL_SECONDS, nx=True)
        reverse_key = f"task_to_hash:{task_id}"
        await redis.set(reverse_key, payload_hash, ex=DEDUP_TTL_SECONDS)
        await redis.set(f"job:owner:{task_id}", token, ex=DEDUP_TTL_SECONDS)
    except Exception as e:
        logger.error("Failed to write dedup keys to Redis: %s", e)

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
async def get_job_status(job_id: str):
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
    redis = _get_dedup_redis()
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
    await redis.delete(f"job:owner:{job_id}")

    logger.info("Job %s cancelled and dedup cleared", job_id)
    return {"job_id": job_id, "status": "cancelled"}
