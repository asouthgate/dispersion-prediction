import logging

from fastapi import APIRouter, Header, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

from services.analytics import daily_token_hash, emit_pageview, is_ready
from services.redis import get_redis

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/analytics", tags=["analytics"])

# This endpoint is unauthenticated (fires before/alongside token mint), so it
# is a potential vector for filling the Umami database with junk rows. The
# per-IP rate limit and the field length caps below bound that abuse.
RATE_LIMIT_PER_MINUTE = 30


class AnalyticsEvent(BaseModel):
    type: str = Field(max_length=32)
    url: str = Field(default="/", max_length=512)
    title: str = Field(default="", max_length=256)
    referrer: str = Field(default="", max_length=512)
    consent: bool = False


@router.post("/event")
async def post_event(event: AnalyticsEvent, request: Request, authorization: str | None = Header(None)):
    if not is_ready():
        return Response(status_code=204)

    if not event.consent:
        return Response(status_code=204)

    forwarded = request.headers.get("X-Forwarded-For")
    ip = forwarded.split(",")[0].strip() if forwarded else (
        request.client.host if request.client else "unknown"
    )
    try:
        redis = get_redis()
        rate_key = f"analytics:rate:{ip}"
        count = await redis.incr(rate_key)
        if count == 1:
            await redis.expire(rate_key, 60)
        if count > RATE_LIMIT_PER_MINUTE:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests",
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("Analytics rate limit check failed: %s", e)

    user_id = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
        user_id = daily_token_hash(token)

    emit_pageview(event.url, event.title, event.referrer, user_id=user_id)
    return Response(status_code=204)
