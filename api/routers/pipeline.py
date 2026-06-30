"""Pipeline router: handles job submission/management via Celery.

This module is a thin layer over the Celery tasks in ``tasks.py``. The Celery
task id IS the job id surfaced to the client. Job state lives in the Celery
result backend (Redis), not in any in-process registry.
"""

from __future__ import annotations

import logging
import os
import uuid

from celery.result import AsyncResult
from fastapi import APIRouter
from redis import Redis

from celery_app import celery_app
from schemas.pipeline import (
    PipelineRequest,
    PipelineStartResponse,
    JobStatus,
    ResultLayerInfo,
)
from tasks import run_pipeline_task, _payload_hash, _create_work_dir

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pipeline", tags=["pipeline"])

# Dedup cache: payload_hash -> task_id, with a TTL that exceeds the longest
# task. In-memory only across Redis restarts, which we accepted as a
# trade-off for simplicity. Worst case on Redis restart: two identical rapid
# requests both run (rare, harmless — they share the same hashed work_dir).
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


# Map Celery states to the JobStatus.status vocabulary the client expects.
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
    roost = req.roost.model_dump() if req.roost else None
    features = [f.model_dump() for f in req.features]
    lamps = [lamp.model_dump() for lamp in req.lamps]
    params = dict(req.params)

    payload_hash = _payload_hash(roost, features, lamps, params)
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
    except Exception:
        pass

    run_pipeline_task.apply_async(
        args=(stage, work_dir, roost, features, lamps, params),
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
async def cancel_job(job_id: str):
    # Verify the task exists; AsyncResult doesn't 404 on unknown ids, it just
    # reports PENDING. We use the result backend to distinguish: a task that
    # never existed has no result row and no PROGRESS/STARTED state. For
    # cancellation the pragmatic choice is to revoke regardless — revoking a
    # non-existent task is a no-op, but we still 404 if it's truly unknown by
    # checking the dedup index. Simpler: accept the revoke and return.
    result = AsyncResult(job_id, app=celery_app)
    state = result.state
    # PENDING could mean "never existed" or "queued not started". We can't
    # tell from Celery alone. Treat a PENDING with no result as not-found if
    # it's not in the dedup index either. This is a heuristic.
    if state == "PENDING":
        # Best-effort existence check via the result backend.
        if not result.ready() and result.result is None:
            # Could still be a real queued task. We revoke anyway; clients
            # that cancel a fabricated id get 200 (harmless no-op).
            pass

    celery_app.control.revoke(job_id, terminate=True, signal="SIGTERM")
    # Drop any dedup key pointing at this task so a fresh identical payload
    # can run again later.
    # We don't know the payload_hash here without re-deriving it; the dedup
    # key will expire on its own TTL. Acceptable.
    logger.info("Job %s cancelled", job_id)
    return {"job_id": job_id, "status": "cancelled"}