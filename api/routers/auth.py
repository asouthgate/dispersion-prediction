"""Auth router: session token generation and revocation."""

from __future__ import annotations

import logging
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status

from middleware.auth import require_auth
from middleware.rate_limit import arm_cooldown, rate_limit, require_cooldown
from services.redis import get_redis
from config import TOKEN_TTL_SECONDS, RATE_LIMIT_TOKENS_PER_MINUTE

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# Per-IP guards on token minting: a 5s cooldown after each successful mint,
# plus a hard cap per minute. Both are best-effort (fail-open) — see
# middleware/rate_limit.py.
TOKEN_COOLDOWN_SECONDS = 5


@router.post(
    "/token",
    dependencies=[
        Depends(require_cooldown("auth_token", TOKEN_COOLDOWN_SECONDS)),
        Depends(rate_limit("auth_token", RATE_LIMIT_TOKENS_PER_MINUTE)),
    ],
)
async def create_token(request: Request):
    """Generate a new session token stored in Redis with a TTL."""
    token = uuid.uuid4().hex
    key = f"auth:token:{token}"
    created_at = time.time()
    expires_at = created_at + TOKEN_TTL_SECONDS

    redis = get_redis()
    try:
        await redis.set(key, str(created_at), ex=TOKEN_TTL_SECONDS)
    except Exception as e:
        logger.error("Failed to store auth token in Redis: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to create session",
        )

    # Only armed on success: rejected requests must not start the cooldown.
    await arm_cooldown(request, "auth_token", TOKEN_COOLDOWN_SECONDS)

    logger.info("New session token created")
    return {"token": token, "expires_at": expires_at}


@router.delete("/token")
async def revoke_token(token: str = Depends(require_auth)):
    """Revoke the current session token."""
    key = f"auth:token:{token}"
    try:
        await get_redis().delete(key)
    except Exception as e:
        logger.error("Failed to revoke token: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to revoke session",
        )

    logger.info("Session token revoked")
    return {"status": "revoked"}
