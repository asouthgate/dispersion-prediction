"""Shared rate limiting and cooldown helpers.

Two reusable guards, built as FastAPI dependency factories so routers can
declare them inline:

    @router.post("/x", dependencies=[Depends(rate_limit("analytics", 30))])

Both fail open: if Redis hiccups during a check the request is allowed and a
warning is logged. Rate limiting must never take the API down with it.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from fastapi import HTTPException, Request, status

from services.redis import get_redis

logger = logging.getLogger(__name__)


def client_ip(request: Request) -> str:
    """Best-effort client IP: leftmost X-Forwarded-For entry if present
    (set by the upstream proxy), otherwise the direct peer."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    client = request.client
    return client.host if client else "unknown"


def rate_limit(scope: str, per_minute: int) -> Callable[[Request], Awaitable[None]]:
    """Allow at most ``per_minute`` requests per minute per client IP.

    ``scope`` namespaces the Redis keys so different endpoints track
    independent counters (e.g. "auth_token" vs "analytics").
    """
    async def _check(request: Request) -> None:
        ip = client_ip(request)
        key = f"rate:{scope}:{ip}"
        try:
            redis = get_redis()
            count = await redis.incr(key)
            if count == 1:
                await redis.expire(key, 60)
            if count > per_minute:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Too many requests. Please wait a minute.",
                )
        except HTTPException:
            raise
        except Exception as e:
            logger.warning("Rate limit check failed (%s): %s", scope, e)

    return _check


def require_cooldown(scope: str, seconds: int) -> Callable[[Request], Awaitable[None]]:
    """Reject with 429 if this client IP succeeded less than ``seconds`` ago.

    The cooldown key is only ever written by :func:`arm_cooldown` after a
    successful request, so failed attempts don't restart the wait.
    """
    async def _check(request: Request) -> None:
        ip = client_ip(request)
        key = f"cooldown:{scope}:{ip}"
        try:
            if await get_redis().exists(key):
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Please wait before trying again.",
                )
        except HTTPException:
            raise
        except Exception as e:
            logger.warning("Cooldown check failed (%s): %s", scope, e)

    return _check


async def arm_cooldown(request: Request, scope: str, seconds: int) -> None:
    """Start the cooldown for this client IP. Call only on success."""
    ip = client_ip(request)
    key = f"cooldown:{scope}:{ip}"
    try:
        await get_redis().set(key, "1", ex=seconds)
    except Exception as e:
        logger.warning("Failed to arm cooldown (%s): %s", scope, e)
