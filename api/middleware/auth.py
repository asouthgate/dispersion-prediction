"""Authentication middleware: validates session tokens stored in Redis."""

from __future__ import annotations

import os
import logging

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from redis import Redis

logger = logging.getLogger(__name__)

security = HTTPBearer()

_redis: Redis | None = None
TOKEN_TTL_SECONDS = 86400  # 24h sliding window


def _redis_client() -> Redis:
    global _redis
    if _redis is None:
        _redis = Redis.from_url(
            os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/0"),
            decode_responses=True,
        )
    return _redis


def require_auth(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    """FastAPI dependency that validates a Bearer token against Redis.

    Returns the token string on success.  Raises 401 on failure.
    Sliding TTL: every valid request resets the expiry to 24h.
    """
    token = credentials.credentials
    key = f"auth:token:{token}"

    try:
        exists = _redis_client().exists(key)
    except Exception as e:
        logger.error("Redis error during auth check: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable",
        )

    if not exists:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        _redis_client().expire(key, TOKEN_TTL_SECONDS)
    except Exception:
        pass  # non-critical; request is already authenticated

    return token
