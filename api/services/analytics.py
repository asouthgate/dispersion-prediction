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

from config import ANALYTICS_HASH_SECRET

logger = logging.getLogger(__name__)

_UMAMI_URL = os.environ.get("UMAMI_URL", "").rstrip("/")
_APP_HOSTNAME = os.environ.get("ANALYTICS_HOSTNAME", "bat-dispersion-app")
_USER_AGENT = "DispersionAppBackend/1.0 (Analytics Client)"

# Umami hardcodes its first-run admin account; there is no env var to change it.
_SEED_ADMIN_USER = "admin"
_SEED_ADMIN_PASSWORD = os.environ.get("UMAMI_SEED_ADMIN_PASSWORD", "umami")

_UMAMI_ADMIN_USER = os.environ.get("UMAMI_ADMIN_USER", "admin")
_UMAMI_ADMIN_PASSWORD = os.environ.get("UMAMI_ADMIN_PASSWORD", "")

if _UMAMI_URL and not _UMAMI_ADMIN_PASSWORD:
    raise RuntimeError("UMAMI_ADMIN_PASSWORD must be set when UMAMI_URL is configured")

# Website id: optional config override; otherwise ensured/created by
# init_analytics() and cached here.
_website_id = os.environ.get("UMAMI_WEBSITE_ID", "").strip()

_bootstrap_started = False
_bootstrap_lock = threading.Lock()

_max_workers = int(os.environ.get("ANALYTICS_MAX_WORKERS", "4"))
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=_max_workers, thread_name_prefix="analytics")
# Bound the pending-send backlog: if Umami is slow/unreachable, excess events
# are dropped rather than piling up unboundedly in memory. Analytics must
# never affect the app.
_send_slots = threading.BoundedSemaphore(_max_workers * 8)


def daily_token_hash(token: str) -> str:
    today = date.today().isoformat()
    raw = f"{token}:{today}"
    return hmac.new(ANALYTICS_HASH_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()[:16]


def is_ready() -> bool:
    return bool(_UMAMI_URL and _website_id)


def _send_url() -> str:
    return f"{_UMAMI_URL}/api/send"


def _admin_request(method: str, path: str, token: str | None = None, body: dict | None = None, quiet: bool = False) -> dict | None:
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
    except urllib.error.HTTPError as e:
        # An HTTP status error (e.g. 401 during bootstrap) is an expected,
        # recoverable condition, not a transport failure.
        logger.debug("Umami admin request %s %s returned HTTP %d", method, path, e.code)
        return None
    except urllib.error.URLError as e:
        if quiet:
            logger.debug("Umami admin request %s %s failed (network): %s", method, path, e)
        else:
            logger.warning("Umami admin request %s %s failed (network): %s", method, path, e)
        return None
    except json.JSONDecodeError as e:
        logger.warning("Umami admin request %s %s returned invalid JSON: %s", method, path, e)
        return None


def _admin_login(username: str, password: str) -> str | None:
    login = _admin_request(
        "POST", "/api/auth/login",
        body={"username": username, "password": password},
        quiet=True,
    )
    return login.get("token") if login else None


def _bootstrap_admin(admin_user: str, admin_pass: str) -> bool:
    """Reset the Umami admin password from the first-run seed (admin/umami).

    Umami seeds a default admin on first boot and exposes no env override, so on
    a fresh database the configured credentials won't match. Log in with the
    seed account and update the admin password to the configured value.

    Idempotent: once the password has been changed the seed login fails, so this
    becomes a no-op on subsequent boots. Returns True if the password was reset.
    """
    if admin_user == _SEED_ADMIN_USER and admin_pass == _SEED_ADMIN_PASSWORD:
        return False  # nothing to change

    login = _admin_request(
        "POST", "/api/auth/login",
        body={"username": _SEED_ADMIN_USER, "password": _SEED_ADMIN_PASSWORD},
        quiet=True,
    )
    if not login or not login.get("token"):
        return False  # not seeded yet, or already configured

    user = login.get("user") or {}
    user_id = user.get("id")
    if not user_id:
        logger.warning("Umami seed login returned no user id; cannot bootstrap admin password")
        return False

    updated = _admin_request(
        "POST", f"/api/users/{user_id}",
        token=login["token"],
        body={"password": admin_pass},
    )
    if updated is None:
        logger.error("Failed to update Umami admin password from seed account")
        return False

    logger.info("Umami admin password updated from seed default (user=%s)", admin_user)
    return True


def _ensure_website_id(token: str, create: bool) -> None:
    """Resolve the Umami website id, caching it.

    Looks up the website by name. If it doesn't exist and ``create`` is True
    (API), create it. Workers pass ``create=False`` and poll until the API has
    created it.
    """
    global _website_id

    backoff = 2.0
    while True:
        websites = _admin_request("GET", "/api/websites", token=token)
        if websites and websites.get("data"):
            for site in websites["data"]:
                if site.get("name") == _APP_HOSTNAME:
                    _website_id = site.get("id", "")
                    logger.info("Found existing Umami website: %s", _website_id)
                    return

        if create:
            created = _admin_request(
                "POST", "/api/websites", token=token,
                body={"name": _APP_HOSTNAME, "domain": "localhost"},
            )
            if created and created.get("id"):
                _website_id = created["id"]
                logger.info("Created Umami website: %s (%s)", _website_id, _APP_HOSTNAME)
                return
            logger.warning("Failed to create Umami website; will retry")

        _time.sleep(backoff)
        backoff = min(backoff * 2, 60.0)


def _bootstrap_loop(create: bool) -> None:
    """Wait for Umami, ensure the admin credentials work, then resolve the id.

    Retries forever (with backoff) until the configured admin credentials are
    accepted, so a slow first-boot Umami doesn't disable analytics.
    """
    backoff = 2.0
    while True:
        if not _UMAMI_URL:
            return
        token = _admin_login(_UMAMI_ADMIN_USER, _UMAMI_ADMIN_PASSWORD)
        if token:
            break
        if _bootstrap_admin(_UMAMI_ADMIN_USER, _UMAMI_ADMIN_PASSWORD):
            continue
        _time.sleep(backoff)
        backoff = min(backoff * 2, 60.0)

    if not _website_id:
        _ensure_website_id(token, create)


def _start_analytics_init(create: bool) -> None:
    """Spawn the background analytics init thread (idempotent per process)."""
    global _bootstrap_started
    if _bootstrap_started or not _UMAMI_URL:
        return
    with _bootstrap_lock:
        if _bootstrap_started:
            return
        _bootstrap_started = True
    threading.Thread(target=_bootstrap_loop, args=(create,), daemon=True, name="analytics-init").start()


def init_analytics() -> None:
    """API startup: bootstrap the admin password and create the website if missing.

    Spawns a background daemon thread and returns immediately. Idempotent per
    process, and a no-op when analytics is not configured (UMAMI_URL unset).
    """
    _start_analytics_init(create=True)


def get_analytics_id() -> None:
    """Worker startup: resolve the website id without ever creating it.

    Logs in and polls by name until the API has created the website, then
    caches the id. Spawns a background daemon thread and returns immediately.
    """
    _start_analytics_init(create=False)


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
    if not _UMAMI_URL or not _website_id:
        return
    data = json.dumps(payload, default=str).encode("utf-8")
    if not _send_slots.acquire(blocking=False):
        logger.debug("Analytics send queue full, dropping event")
        return
    future = _executor.submit(_post_umami, data)
    future.add_done_callback(lambda _f: _send_slots.release())


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
