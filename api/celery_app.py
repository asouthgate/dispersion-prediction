"""Celery application and configuration for pipeline jobs."""

from __future__ import annotations

import os

from celery import Celery
from celery.schedules import crontab

from config import PIPELINE_TIMEOUT

celery_app = Celery(
    "dispersion",
    broker=os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/0"),
    backend=os.environ.get("CELERY_RESULT_BACKEND", "redis://localhost:6379/1"),
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
    # Beat schedule: prune orphaned work_dirs every hour.
    beat_schedule={
        "cleanup-work-dirs": {
            "task": "tasks.cleanup_work_dirs",
            "schedule": crontab(minute=0),
        },
    },
)