"""Celery application and configuration for pipeline jobs."""

from __future__ import annotations

from celery import Celery
from celery.schedules import crontab
from celery.signals import worker_process_init

from config import PIPELINE_TIMEOUT, CELERY_BROKER_URL, CELERY_RESULT_BACKEND

from services.analytics import get_analytics_id

celery_app = Celery(
    "dispersion",
    broker=CELERY_BROKER_URL,
    backend=CELERY_RESULT_BACKEND,
    include=["tasks"],
)


@worker_process_init.connect
def _on_worker_process_init(**kwargs):
    get_analytics_id()

celery_app.conf.update(
    task_track_started=True,
    task_acks_late=True,
    # If a worker dies mid-task (e.g. OOM-killed), fail the task instead of
    # requeueing it. A task that reliably kills the worker would otherwise
    # loop forever on every `restart: always` cycle.
    task_reject_on_worker_lost=True,
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
        "prune-umami-events": {
            "task": "tasks.prune_umami_events",
            "schedule": crontab(hour=3, minute=15),
        },
    },
)
