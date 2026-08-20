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

        def fake_request(method, path, token=None, body=None, quiet=False):
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
        def fake_request(method, path, token=None, body=None, quiet=False):
            if path == "/api/auth/login":
                return {"token": "seed-token", "user": {}}
            return None

        with patch.object(a, "_admin_request", side_effect=fake_request):
            self.assertFalse(a._bootstrap_admin("admin", "newpass"))


class WebsiteIdTests(unittest.TestCase):

    def setUp(self):
        self._orig_website_id = a._website_id
        self._orig_url = a._UMAMI_URL

    def tearDown(self):
        a._website_id = self._orig_website_id
        a._UMAMI_URL = self._orig_url

    def test_finds_existing_website_by_name(self):
        def fake_request(method, path, token=None, body=None):
            if method == "GET" and path == "/api/websites":
                return {"data": [
                    {"id": "w1", "name": "other"},
                    {"id": "w2", "name": a._APP_HOSTNAME},
                ]}
            return None

        with patch.object(a, "_admin_request", side_effect=fake_request) as mock:
            a._ensure_website_id("tok", create=False)

        self.assertEqual(a._website_id, "w2")
        self.assertEqual(mock.call_count, 1)

    def test_creates_website_when_missing(self):
        def fake_request(method, path, token=None, body=None):
            if method == "GET" and path == "/api/websites":
                return {"data": []}
            if method == "POST" and path == "/api/websites":
                return {"id": "w9"}
            return None

        with patch.object(a, "_admin_request", side_effect=fake_request) as mock:
            a._ensure_website_id("tok", create=True)

        self.assertEqual(a._website_id, "w9")
        self.assertEqual(mock.call_count, 2)

    def test_find_only_does_not_create(self):
        calls = []
        polls = {"count": 0}

        def fake_request(method, path, token=None, body=None):
            calls.append((method, path))
            if method == "GET" and path == "/api/websites":
                polls["count"] += 1
                if polls["count"] == 1:
                    return {"data": []}
                return {"data": [{"id": "w2", "name": a._APP_HOSTNAME}]}
            return None

        with patch.object(a, "_admin_request", side_effect=fake_request):
            with patch.object(a._time, "sleep"):
                a._ensure_website_id("tok", create=False)

        self.assertEqual(a._website_id, "w2")
        self.assertFalse(any(m == "POST" for m, _ in calls))

    def test_is_ready_requires_url_and_website_id(self):
        a._UMAMI_URL = ""
        a._website_id = "w1"
        self.assertFalse(a.is_ready())

        a._UMAMI_URL = "http://umami:3084"
        a._website_id = ""
        self.assertFalse(a.is_ready())

        a._website_id = "w1"
        self.assertTrue(a.is_ready())


if __name__ == "__main__":
    unittest.main()
