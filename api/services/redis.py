import logging

import redis.asyncio as aioredis

from config import AUTH_REDIS_URL

logger = logging.getLogger(__name__)

_redis: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(AUTH_REDIS_URL, decode_responses=True)
    return _redis
