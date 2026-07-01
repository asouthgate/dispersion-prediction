"""Tests for _sanitize_error (now lives in tasks.py)."""

import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tasks import _sanitize_error


class SanitizeErrorTests(unittest.TestCase):

    def test_rscript_missing(self):
        msg = 'No such file or directory: Rscript'
        result = _sanitize_error(msg)
        self.assertIn("R environment not configured", result)
        self.assertNotIn("Rscript", result)

    def test_r_script_not_found(self):
        result = _sanitize_error("R script not found: scripts/foo.R")
        self.assertIn("pipeline script is not available", result)

    def test_timeout(self):
        result = _sanitize_error("Process timed out after 600 seconds")
        self.assertIn("took too long", result)

    def test_no_result_layers(self):
        result = _sanitize_error("Coverage pipeline produced no result layers — check database")
        self.assertIn("No data is available", result)

    def test_permission_denied(self):
        result = _sanitize_error("Permission denied: /tmp/circuitscape")
        self.assertIn("unable to access required data files", result)

    def test_database_connection(self):
        result = _sanitize_error("could not connect to postgres database")
        self.assertIn("Unable to connect to the spatial database", result)

    def test_long_message_returns_generic(self):
        long_msg = "x" * 250
        result = _sanitize_error(long_msg)
        self.assertIn("internal error", result.lower())

    def test_unmatched_short_message_returns_generic(self):
        result = _sanitize_error("Some random error text")
        self.assertIn("internal error", result.lower())
        self.assertNotIn("Some random error text", result)


if __name__ == "__main__":
    unittest.main()
