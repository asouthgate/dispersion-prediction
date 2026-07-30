import logging

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from config import ANALYTICS_RATE_LIMIT_PER_MINUTE
from middleware.rate_limit import rate_limit
from services.analytics import daily_token_hash, emit_pageview, is_ready

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/analytics", tags=["analytics"])

# This endpoint is unauthenticated (fires before/alongside token mint), so it
# is a potential vector for filling the Umami database with junk rows. The
# per-IP rate limit and the field length caps below bound that abuse.


class AnalyticsEvent(BaseModel):
    type: str = Field(max_length=32)
    url: str = Field(default="/", max_length=512)
    title: str = Field(default="", max_length=256)
    referrer: str = Field(default="", max_length=512)
    consent: bool = False


@router.post(
    "/event",
    dependencies=[Depends(rate_limit("analytics", ANALYTICS_RATE_LIMIT_PER_MINUTE))],
)
async def post_event(event: AnalyticsEvent, request: Request, authorization: str | None = Header(None)):
    if not is_ready():
        return Response(status_code=204)

    if not event.consent:
        return Response(status_code=204)

    user_id = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
        user_id = daily_token_hash(token)

    emit_pageview(event.url, event.title, event.referrer, user_id=user_id)
    return Response(status_code=204)
