import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("ANALYTICS_HASH_SECRET", "test-secret")
os.environ.setdefault("CELERY_BROKER_URL", "memory://")
os.environ.setdefault("CELERY_RESULT_BACKEND", "cache+memory://")

import services.analytics as a  # noqa: E402


class BootstrapAdminTests(unittest.TestCase):

    def _seed_login(self):
        return {"token": "seed-token", "user": {"id": "u1", "username": "admin"}}

    def test_updates_password_from_seed(self):
        calls = []

        def fake_request(method, path, token=None, body=None):
            calls.append((method, path, token, body))
            if path == "/api/auth/login":
                return self._seed_login()
            if path == "/api/users/u1":
                return {"id": "u1", "username": "admin"}
            return None

        with patch.object(a, "_admin_request", side_effect=fake_request):
            self.assertTrue(a._bootstrap_admin("admin", "newpass"))

        update = [c for c in calls if c[0] == "POST" and c[1] == "/api/users/u1"]
        self.assertEqual(len(update), 1)
        self.assertEqual(update[0][2], "seed-token")
        self.assertEqual(update[0][3], {"password": "newpass"})

    def test_noop_when_same_password(self):
        with patch.object(a, "_admin_request") as mock:
            self.assertFalse(a._bootstrap_admin("admin", "umami"))
            mock.assert_not_called()

    def test_noop_when_seed_login_fails(self):
        with patch.object(a, "_admin_request", return_value=None) as mock:
            self.assertFalse(a._bootstrap_admin("admin", "newpass"))
            self.assertEqual(mock.call_count, 1)

    def test_noop_when_no_user_id(self):
        def fake_request(method, path, token=None, body=None):
            if path == "/api/auth/login":
                return {"token": "seed-token", "user": {}}
            return None

        with patch.object(a, "_admin_request", side_effect=fake_request):
            self.assertFalse(a._bootstrap_admin("admin", "newpass"))


if __name__ == "__main__":
    unittest.main()
