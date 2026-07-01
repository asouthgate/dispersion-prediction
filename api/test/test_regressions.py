"""Regression tests for known bugs."""

import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class UnifiedFeaturesRegression(unittest.TestCase):
    """Regression test: features and lamps are unified, no separate lamps field."""

    def test_pipeline_request_no_lamps_field(self):
        """PipelineRequest should not have a lamps field."""
        from schemas.pipeline import PipelineRequest
        fields = PipelineRequest.model_fields
        self.assertIn("features", fields)
        self.assertNotIn("lamps", fields, "lamps field should not exist in PipelineRequest")

    def test_payload_hash_no_lamps(self):
        """_payload_hash should not accept a lamps parameter."""
        from tasks import _payload_hash
        import inspect
        sig = inspect.signature(_payload_hash)
        params = list(sig.parameters.keys())
        self.assertIn("stage", params)
        self.assertIn("features", params)
        self.assertNotIn("lamps", params, "lamps parameter should not exist in _payload_hash")


if __name__ == "__main__":
    unittest.main()
