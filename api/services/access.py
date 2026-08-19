"""Job access-control helper shared by the pipeline and raster routers."""

from __future__ import annotations

import logging

from fastapi import HTTPException, status

logger = logging.getLogger(__name__)


async def check_job_access(redis, job_id: str, token: str) -> None:
    """Enforce read access to a job: the owner, or a viewer added via a dedup hit.

    Raises 403 if the token is neither the owner nor a viewer. Fails closed: a
    job with no owner record (e.g. an expired key) is treated as inaccessible.
    """
    try:
        owner = await redis.get(f"job:owner:{job_id}")
    except Exception as e:
        logger.error("Redis error during job owner lookup: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service unavailable",
        )

    if owner == token:
        return

    try:
        is_viewer = await redis.sismember(f"job:viewers:{job_id}", token)
    except Exception as e:
        logger.error("Redis error during viewer lookup: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service unavailable",
        )

    if not is_viewer:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only view your own jobs",
        )
