"""pytest configuration: run Celery tasks eagerly + use an in-memory Redis.

Eager mode executes the task body inline in the calling process during
``apply_async`` / ``delay``. This is exactly the behaviour we want for unit
tests — no live broker or worker container required.

The dedup client in ``routers.pipeline`` points at a fakeredis-backed Redis
so tests can exercise dedup logic without a real Redis container.
"""

from __future__ import annotations

import os
import sys

# Ensure the API package is importable in tests that use module-style imports
# matching the worker (which runs with cwd=/app/api).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("ANALYTICS_HASH_SECRET", "test-secret")
# Configure Celery to run eagerly before importing anything that pulls celery_app.
os.environ.setdefault("CELERY_BROKER_URL", "memory://")
os.environ.setdefault("CELERY_RESULT_BACKEND", "cache+memory://")
os.environ.setdefault("PIPELINE_WORK_DIR", "/tmp/circuitscape-test")

import pytest  # noqa: E402

from celery_app import celery_app  # noqa: E402


@pytest.fixture(autouse=True)
def _eager_celery():
    """Run task bodies inline and store results locally for the duration of
    each test so AsyncResult reads them back in-process."""
    prev = celery_app.conf
    celery_app.conf.update(
        task_always_eager=True,
        task_eager_propagates=False,  # let FAILURE be inspectable, not raised
        task_store_eager_result=True,
    )
    # Re-bind the task registry now that the app is configured.
    import tasks  # noqa: F401
    yield
    celery_app.conf.update(
        task_always_eager=prev.task_always_eager,
        task_eager_propagates=prev.task_eager_propagates,
    )


@pytest.fixture()
def fake_redis(monkeypatch):
    """Patch routers.pipeline._dedup_client to return a fakeredis instance."""
    import fakeredis
    server = fakeredis.FakeServer()
    client = fakeredis.FakeStrictRedis(server=server, decode_responses=True)
    import routers.pipeline as p
    monkeypatch.setattr(p, "_redis", client)
    return client