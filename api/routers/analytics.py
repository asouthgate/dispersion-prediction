from fastapi import APIRouter, Header, Request
from fastapi.responses import Response
from pydantic import BaseModel

from services.analytics import daily_token_hash, emit_pageview, is_ready

router = APIRouter(prefix="/analytics", tags=["analytics"])


class AnalyticsEvent(BaseModel):
    type: str
    url: str = "/"
    title: str = ""
    referrer: str = ""
    consent: bool = False


@router.post("/event")
async def post_event(event: AnalyticsEvent, request: Request, authorization: str | None = Header(None)):
    if not is_ready():
        return Response(status_code=204)

    if not event.consent:
        return Response(status_code=204)

    user_id = None
    if event.consent and authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
        user_id = daily_token_hash(token)

    emit_pageview(event.url, event.title, event.referrer, user_id=user_id)
    return Response(status_code=204)
