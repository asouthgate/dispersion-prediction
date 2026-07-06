"""Celery application and configuration for pipeline jobs."""

from __future__ import annotations

from celery import Celery
from celery.schedules import crontab

from config import PIPELINE_TIMEOUT, _broker_url, _result_backend

celery_app = Celery(
    "dispersion",
    broker=_broker_url,
    backend=_result_backend,
    include=["tasks"],
)

celery_app.conf.update(
    task_track_started=True,
    task_acks_late=True,
    worker_cancel_long_running_tasks_on_connection_loss=True,
    task_time_limit=PIPELINE_TIMEOUT,
    task_soft_time_limit=PIPELINE_TIMEOUT - 300,
    result_expires=24 * 3600,
    visibility_timeout=PIPELINE_TIMEOUT * 2,
    beat_schedule={
        "cleanup-work-dirs": {
            "task": "tasks.cleanup_work_dirs",
            "schedule": crontab(minute=0),
        },
    },
)
