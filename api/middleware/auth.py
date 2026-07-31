"""Authentication middleware: validates session tokens stored in Redis."""

from __future__ import annotations

import logging

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from config import TOKEN_TTL_SECONDS
from services.redis import get_redis

logger = logging.getLogger(__name__)

security = HTTPBearer(auto_error=False)


async def require_auth(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> str:
    """FastAPI dependency that validates a Bearer token against Redis.

    Returns the token string on success.  Raises 401 on failure.
    Sliding TTL: every valid request resets the expiry.
    """
    if credentials is None:
        authorization = request.headers.get("Authorization")
        if not authorization:
            logger.info("Auth check: no Authorization header")
        else:
            logger.info("Auth check: malformed Authorization header (%d chars)", len(authorization))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = credentials.credentials
    key = f"auth:token:{token}"
    logger.info("Auth check: prefix=%s.., key=%s", token[:8], key)

    try:
        redis = get_redis()
        value = await redis.getex(key, ex=TOKEN_TTL_SECONDS)
    except Exception as e:
        logger.error("Redis error during auth check: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable",
        )

    if value is None:
        logger.warning("Token not found in Redis (prefix=%s..)", token[:8])
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    logger.info("Token validated (prefix=%s..)", token[:8])
    return token
