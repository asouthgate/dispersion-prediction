"""Tests for _try_parse_log_line and _log_redact in tasks.py."""

import json
import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tasks import _try_parse_log_line, _log_redact


class TryParseLogLineTests(unittest.TestCase):

    def test_user_visible_info(self):
        line = json.dumps({"user_visible": True, "level": "info", "msg": "Processing step 1"})
        result = _try_parse_log_line(line + "\n")
        self.assertEqual(result, "Processing step 1")

    def test_user_visible_warn_stderr_prefix(self):
        line = json.dumps({"user_visible": True, "level": "warn", "msg": "Some raster data failed"})
        result = _try_parse_log_line(line + "\n")
        self.assertEqual(result, "stderr:WARN: Some raster data failed")

    def test_user_visible_error_stderr_prefix(self):
        line = json.dumps({"user_visible": True, "level": "error", "msg": "Pipeline failed"})
        result = _try_parse_log_line(line + "\n")
        self.assertEqual(result, "stderr:ERROR: Pipeline failed")

    def test_not_user_visible_dropped(self):
        line = json.dumps({"user_visible": False, "level": "info", "msg": "secret"})
        result = _try_parse_log_line(line + "\n")
        self.assertIsNone(result)

    def test_no_user_visible_key_dropped(self):
        line = json.dumps({"level": "info", "msg": "something"})
        result = _try_parse_log_line(line + "\n")
        self.assertIsNone(result)

    def test_non_json_line_dropped(self):
        result = _try_parse_log_line("[INFO] 2024-01-01 raw log line\n")
        self.assertIsNone(result)

    def test_empty_line_dropped(self):
        result = _try_parse_log_line("   \n")
        self.assertIsNone(result)

    def test_empty_string_dropped(self):
        result = _try_parse_log_line("")
        self.assertIsNone(result)

    def test_missing_msg_field_defaults_empty(self):
        line = json.dumps({"user_visible": True, "level": "info"})
        result = _try_parse_log_line(line + "\n")
        self.assertEqual(result, "")

    def test_no_level_field_defaults_to_info(self):
        line = json.dumps({"user_visible": True, "msg": "defaults to info"})
        result = _try_parse_log_line(line + "\n")
        self.assertEqual(result, "defaults to info")


class LogRedactTests(unittest.TestCase):

    def test_pgpassword_redacted(self):
        result = _log_redact("Connected with PGPASSWORD=secret123")
        self.assertNotIn("secret123", result)

    def test_password_equals_redacted(self):
        result = _log_redact("password=supersecret db connection")
        self.assertNotIn("supersecret", result)

    def test_postgres_url_redacted(self):
        result = _log_redact("Connecting to postgresql://user:pass@host:5432/db")
        self.assertNotIn("user:pass", result)

    def test_postgres_url_variant_redacted(self):
        result = _log_redact("URL: postgres://admin:secret@localhost/mydb")
        self.assertNotIn("secret", result)

    def test_clean_message_passes_through(self):
        result = _log_redact("Creating extent...")
        self.assertEqual(result, "Creating extent...")

    def test_pipeline_progress_passes_through(self):
        result = _log_redact("Writing dtm.tif -> /tmp/work/dtm.tif")
        self.assertEqual(result, "Writing dtm.tif -> /tmp/work/dtm.tif")


if __name__ == "__main__":
    unittest.main()
