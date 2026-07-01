"""Tests for error paths: no roost, unknown stage, missing scripts, empty results."""

import os
import sys
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("CELERY_BROKER_URL", "memory://")
os.environ.setdefault("CELERY_RESULT_BACKEND", "cache+memory://")

from celery_app import celery_app
celery_app.conf.update(
    task_always_eager=True,
    task_eager_propagates=False,
    task_store_eager_result=True,
)

from tasks import run_pipeline_task, _run_r_pipeline  # noqa: E402


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

    def test_collect_results_empty_raises(self):
        work_dir = "/tmp/cs/rp-test"
        dummy_root = "/tmp/cs/dummy-root"
        os.makedirs(work_dir, exist_ok=True)
        os.makedirs(os.path.join(dummy_root, "scripts"), exist_ok=True)
        open(os.path.join(dummy_root, "scripts", "run_resistance_pipeline_json.R"), "w").close()
        try:
            with patch("tasks.subprocess.Popen") as mock_popen:
                mock_proc = MagicMock()
                mock_proc.communicate.return_value = ("", "")
                mock_proc.returncode = 0
                mock_proc.pid = 99999
                mock_popen.return_value = mock_proc

                with patch("tasks.REPO_ROOT", dummy_root):
                    with patch("api.services.r_bridge.collect_results", return_value=[]):
                        with self.assertRaises(RuntimeError) as ctx:
                            _run_r_pipeline(
                                run_pipeline_task,
                                work_dir, "resistance",
                                {"lng": -3.5, "lat": 50.5, "radius_meters": 500},
                                [], {"resolution": 10},
                            )
                        self.assertIn("No data is available", str(ctx.exception))
        finally:
            import shutil
            shutil.rmtree("/tmp/cs/rp-test", ignore_errors=True)
            shutil.rmtree("/tmp/cs/dummy-root", ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
