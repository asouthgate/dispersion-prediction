"""Job access-control helper shared by the pipeline and raster routers."""

from __future__ import annotations

import logging

from fastapi import HTTPException, status

logger = logging.getLogger(__name__)


async def check_job_access(redis, job_id: str, token: str) -> None:
    """Enforce that the token is the owner of the job.

    Raises 403 otherwise. Fails closed: a job with no owner record (e.g. an
    expired key) is treated as inaccessible.
    """
    try:
        owner = await redis.get(f"job:owner:{job_id}")
    except Exception as e:
        logger.error("Redis error during job owner lookup: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service unavailable",
        )

    if owner != token:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Inaccessible job",
        )
