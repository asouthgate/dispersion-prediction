"""Auth router: session token generation and revocation."""

from __future__ import annotations

import logging
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status

from middleware.auth import require_auth, _get_redis
from config import TOKEN_TTL_SECONDS, RATE_LIMIT_TOKENS_PER_MINUTE

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    client = request.client
    return client.host if client else "unknown"


@router.post("/token")
async def create_token(request: Request):
    """Generate a new session token stored in Redis with a TTL."""
    ip = _client_ip(request)
    rate_key = f"auth:rate:{ip}"
    redis = _get_redis()

    try:
        count = await redis.incr(rate_key)
        if count == 1:
            await redis.expire(rate_key, 60)
        if count > RATE_LIMIT_TOKENS_PER_MINUTE:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests. Please wait a minute.",
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to check rate limit: %s", e)

    token = uuid.uuid4().hex
    key = f"auth:token:{token}"
    created_at = time.time()
    expires_at = created_at + TOKEN_TTL_SECONDS

    try:
        await redis.set(key, str(created_at), ex=TOKEN_TTL_SECONDS)
    except Exception as e:
        logger.error("Failed to store auth token in Redis: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to create session",
        )

    logger.info("New session token created")
    return {"token": token, "expires_at": expires_at}


@router.delete("/token")
async def revoke_token(token: str = Depends(require_auth)):
    """Revoke the current session token."""
    key = f"auth:token:{token}"
    try:
        await _get_redis().delete(key)
    except Exception as e:
        logger.error("Failed to revoke token: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to revoke session",
        )

    logger.info("Session token revoked")
    return {"status": "revoked"}
