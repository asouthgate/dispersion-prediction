import concurrent.futures
import hashlib
import hmac
import json
import logging
import os
import threading
import time as _time
import urllib.error
import urllib.request
from datetime import date

logger = logging.getLogger(__name__)

_UMAMI_URL = os.environ.get("UMAMI_URL", "").rstrip("/")
_APP_HOSTNAME = os.environ.get("ANALYTICS_HOSTNAME", "bat-dispersion-app")
_USER_AGENT = "DispersionAppBackend/1.0 (Analytics Client)"

_website_id = os.environ.get("UMAMI_WEBSITE_ID", "")
_lock = threading.Lock()
_init_done = bool(_website_id)

_max_workers = int(os.environ.get("ANALYTICS_MAX_WORKERS", "4"))
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=_max_workers, thread_name_prefix="analytics")


def daily_token_hash(token: str) -> str:
    today = date.today().isoformat()
    raw = f"{token}:{today}"
    secret = os.environ.get("ANALYTICS_HASH_SECRET", "")
    if secret:
        return hmac.new(secret.encode(), raw.encode(), hashlib.sha256).hexdigest()[:16]
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def is_ready() -> bool:
    _ensure_website()
    return bool(_UMAMI_URL and _website_id)


def ensure_umami_website() -> None:
    _ensure_website()


def _send_url() -> str:
    return f"{_UMAMI_URL}/api/send"


def _redis_cache() -> object | None:
    try:
        import redis
        _redis_url = os.environ.get("AUTH_REDIS_URL", os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/9"))
        return redis.Redis.from_url(_redis_url, decode_responses=True)
    except ImportError:
        logger.debug("redis package not installed, caching disabled")
        return None
    except Exception:
        logger.warning("Failed to connect to Redis for analytics cache", exc_info=True)
        return None


def _admin_request(method: str, path: str, token: str | None = None, body: dict | None = None) -> dict | None:
    if not _UMAMI_URL:
        return None
    url = f"{_UMAMI_URL}{path}"
    data = json.dumps(body).encode("utf-8") if body else None
    headers = {"Content-Type": "application/json", "User-Agent": _USER_AGENT}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    # urllib does not use connection pooling; low-volume analytics traffic makes
    # this acceptable. Could migrate to httpx if request frequency increases.
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as e:
        logger.warning("Umami admin request %s %s failed (network): %s", method, path, e)
        return None
    except json.JSONDecodeError as e:
        logger.warning("Umami admin request %s %s returned invalid JSON: %s", method, path, e)
        return None


def _ensure_website() -> None:
    global _website_id, _init_done

    if _init_done:
        return

    with _lock:
        if _init_done:
            return

        if _website_id:
            _init_done = True
            return

        if not _UMAMI_URL:
            logger.debug("UMAMI_URL not set, analytics disabled")
            return

        cache = _redis_cache()
        if cache:
            try:
                cached = cache.get(f"umami:website_id:{_APP_HOSTNAME}")
                if cached:
                    _website_id = cached
                    _init_done = True
                    logger.info("Umami website ID loaded from Redis: %s", _website_id)
                    return
            except Exception:
                logger.warning("Redis cache read failed for analytics", exc_info=True)

        admin_user = os.environ.get("UMAMI_ADMIN_USER", "admin")
        admin_pass = os.environ.get("UMAMI_ADMIN_PASSWORD", "umami")

        login = None
        for attempt in range(30):
            login = _admin_request(
                "POST", "/api/auth/login",
                body={"username": admin_user, "password": admin_pass},
            )
            if login and login.get("token"):
                break
            logger.debug("Waiting for Umami (attempt %d/30)...", attempt + 1)
            # _time.sleep blocks the calling thread; acceptable here because
            # this is one-time startup initialization under a lock. After the
            # first call _init_done flips to True and this path is never hit again.
            _time.sleep(2)
        else:
            logger.warning("Umami did not become ready within 60s. Analytics disabled.")
            return

        token = login["token"]

        websites = _admin_request("GET", "/api/websites", token=token)
        if websites and websites.get("data"):
            _website_id = websites["data"][0]["id"]
            logger.info("Found existing Umami website: %s", _website_id)
        else:
            name = os.environ.get("ANALYTICS_HOSTNAME", "bat-dispersion-app")
            created = _admin_request(
                "POST", "/api/websites", token=token,
                body={"name": name, "domain": "localhost"},
            )
            if created and created.get("id"):
                _website_id = created["id"]
                logger.info("Created Umami website: %s (%s)", _website_id, name)
            else:
                logger.warning("Failed to create Umami website. Analytics disabled.")
                return

        if cache:
            try:
                cache.set(f"umami:website_id:{_APP_HOSTNAME}", _website_id)
            except Exception:
                logger.warning("Redis cache write failed for analytics", exc_info=True)

        _init_done = True


def _post_umami(payload_bytes: bytes) -> None:
    try:
        req = urllib.request.Request(
            _send_url(),
            data=payload_bytes,
            headers={
                "Content-Type": "application/json",
                "User-Agent": _USER_AGENT,
            },
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except urllib.error.URLError:
        logger.warning("Umami event send failed (network)", exc_info=True)


def _fire(payload: dict) -> None:
    _ensure_website()
    if not _website_id or not _UMAMI_URL:
        return
    data = json.dumps(payload, default=str).encode("utf-8")
    _executor.submit(_post_umami, data)


def _emit_event(name: str, event_data: dict | None = None, user_id: str | None = None) -> None:
    payload: dict = {
        "hostname": _APP_HOSTNAME,
        "website": _website_id,
        "url": "/",
    }
    if name:
        payload["name"] = name
    if event_data:
        payload["data"] = event_data
    if user_id:
        payload["id"] = user_id
    _fire({"payload": payload, "type": "event"})


def emit_pageview(url: str, title: str, referrer: str = "", user_id: str | None = None) -> None:
    payload: dict = {
        "hostname": _APP_HOSTNAME,
        "website": _website_id,
        "url": url,
        "title": title,
        "referrer": referrer,
    }
    if user_id:
        payload["id"] = user_id
    _fire({"payload": payload, "type": "event"})


def emit_pipeline_submit(stage: str, resolution: int, feature_count: int, has_roost: bool, user_id: str | None = None) -> None:
    _emit_event(
        "pipeline_submit",
        {
            "stage": stage,
            "resolution": resolution,
            "featureCount": feature_count,
            "hasRoost": has_roost,
        },
        user_id=user_id,
    )


def emit_pipeline_complete(stage: str, duration_seconds: float, success: bool) -> None:
    _emit_event(
        "pipeline_complete",
        {
            "stage": stage,
            "duration": round(duration_seconds, 1),
            "success": success,
        },
    )
