"""Authentication middleware: validates session tokens stored in Redis."""

from __future__ import annotations

import logging

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import redis.asyncio as aioredis

from config import AUTH_REDIS_URL, TOKEN_TTL_SECONDS

logger = logging.getLogger(__name__)

security = HTTPBearer()

_redis: aioredis.Redis | None = None


def _get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(AUTH_REDIS_URL, decode_responses=True)
    return _redis


async def require_auth(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    """FastAPI dependency that validates a Bearer token against Redis.

    Returns the token string on success.  Raises 401 on failure.
    Sliding TTL: every valid request resets the expiry.
    """
    token = credentials.credentials
    key = f"auth:token:{token}"

    try:
        redis = _get_redis()
        value = await redis.getex(key, ex=TOKEN_TTL_SECONDS)
    except Exception as e:
        logger.error("Redis error during auth check: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable",
        )

    if value is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return token
