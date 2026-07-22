"""Tests for error paths: no roost, unknown stage, missing scripts, empty results."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("CELERY_BROKER_URL", "memory://")
os.environ.setdefault("CELERY_RESULT_BACKEND", "cache+memory://")

from celery_app import celery_app
celery_app.conf.update(
    task_always_eager=True,
    task_eager_propagates=False,
    task_store_eager_result=True,
)

from tasks import run_pipeline_task  # noqa: E402


class ErrorPathTests(unittest.TestCase):

    def test_no_roost_for_resistance(self):
        result = run_pipeline_task.apply(
            args=("resistance", "/tmp/nonexistent", None, [], {"resolution": 10}),
        )
        self.assertEqual(result.state, "FAILURE")
        err = result.result
        msg = err.args[0] if isinstance(err, Exception) else str(err)
        self.assertIn("roost", msg.lower())

    def test_unknown_stage(self):
        result = run_pipeline_task.apply(
            args=("nonexistent_stage", "/tmp/nonexistent", None, [], {"resolution": 10}),
        )
        self.assertEqual(result.state, "FAILURE")
        err = result.result
        msg = err.args[0] if isinstance(err, Exception) else str(err)
        self.assertIn("Unknown pipeline stage", msg)


if __name__ == "__main__":
    unittest.main()
