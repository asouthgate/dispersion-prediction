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


if __name__ == "__main__":
    unittest.main()
