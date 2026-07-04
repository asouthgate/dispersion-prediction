"""Auth router: session token generation and revocation."""

from __future__ import annotations

import logging
import uuid
import time

from fastapi import APIRouter, Depends, HTTPException, status

from middleware.auth import require_auth, _redis_client, TOKEN_TTL_SECONDS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/token")
async def create_token():
    """Generate a new session token stored in Redis with a 24h TTL."""
    token = uuid.uuid4().hex
    key = f"auth:token:{token}"
    expires_at = time.time() + TOKEN_TTL_SECONDS

    try:
        _redis_client().set(key, "active", ex=TOKEN_TTL_SECONDS)
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
        _redis_client().delete(key)
    except Exception as e:
        logger.error("Failed to revoke token: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to revoke session",
        )

    logger.info("Session token revoked")
    return {"status": "revoked"}
