"""Tests for job state machine transitions via Celery eager mode."""

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("CELERY_BROKER_URL", "memory://")
os.environ.setdefault("CELERY_RESULT_BACKEND", "cache+memory://")

from tasks import run_pipeline_task  # noqa: E402


class JobLifecycleTests(unittest.TestCase):

    def setUp(self):
        from celery_app import celery_app
        celery_app.conf.update(
            task_always_eager=True,
            task_eager_propagates=False,
            task_store_eager_result=True,
        )

    def _make_args(self, stage="resistance"):
        work_dir = "/tmp/circuitscape-test/test-job"
        roost = {"lng": -3.589, "lat": 50.559, "radius_meters": 500.0}
        return stage, work_dir, roost

    def test_status_transitions_to_completed(self):

        mock_layers = [{"id": "total_res", "name": "Total Resistance", "tif_path": "/tmp/t.tif"}]
        mock_warnings = ["coverage sparse"]

        with patch("tasks._run_resistance_pipeline", return_value=(mock_layers, mock_warnings)):
            result = run_pipeline_task.apply(
                args=("resistance", "/tmp/circuitscape-test/test-job",
                      self._make_args()[2], [], {"resolution": 10}),
            )

        self.assertEqual(result.state, "SUCCESS")
        self.assertEqual(result.result["layers"], mock_layers)
        self.assertEqual(result.result["warnings"], mock_warnings)

    def test_failure_sets_friendly_error(self):
        result = run_pipeline_task.apply(
            args=("resistance", "/tmp/circuitscape-test/none",
                  None, [], {"resolution": 10}),
        )
        # No roost -> ValueError inside the task body -> FAILURE state.
        self.assertEqual(result.state, "FAILURE")
        err = result.result
        msg = err.args[0] if isinstance(err, Exception) else str(err)
        self.assertIn("roost", msg.lower())

    def test_unknown_stage_fails(self):
        result = run_pipeline_task.apply(
            args=("nonexistent_stage", "/tmp/circuitscape-test/none",
                  None, [], {"resolution": 10}),
        )
        self.assertEqual(result.state, "FAILURE")
        err = result.result
        msg = err.args[0] if isinstance(err, Exception) else str(err)
        self.assertIn("Unknown pipeline stage", msg)

    def test_cancel_endpoint_revokes_task(self):
        """The DELETE endpoint calls celery_app.control.revoke with terminate."""
        from unittest.mock import AsyncMock, patch
        import routers.pipeline as p

        fake_redis = AsyncMock()
        fake_redis.get.return_value = "fake-token"
        fake_redis.delete = AsyncMock()

        with patch.object(p, "get_redis", return_value=fake_redis):
            with patch("routers.pipeline.AsyncResult") as mock_async:
                mock_result = AsyncMock()
                mock_result.state = "STARTED"
                mock_async.return_value = mock_result

                with patch("routers.pipeline.celery_app.control.revoke") as mock_revoke:
                    import asyncio
                    asyncio.run(p.cancel_job("fake-task-id", token="fake-token"))

            mock_revoke.assert_called_once_with("fake-task-id", terminate=True, signal="SIGTERM")


if __name__ == "__main__":
    unittest.main()
