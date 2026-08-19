"""Tests for job access control (services/access.py)."""

import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.access import check_job_access  # noqa: E402


class _FakeRedis:
    def __init__(self, owner=None, viewers=None):
        self._data = {}
        if owner is not None:
            self._data["job:owner:job1"] = owner
        self._viewers = set(viewers or [])

    async def get(self, key):
        return self._data.get(key)

    async def sismember(self, key, member):
        return member in self._viewers


class JobAccessTests(unittest.TestCase):

    def test_owner_allowed(self):
        async def run():
            await check_job_access(_FakeRedis(owner="tok"), "job1", "tok")

        asyncio.run(run())

    def test_viewer_allowed(self):
        async def run():
            await check_job_access(_FakeRedis(owner="owner", viewers={"viewer"}), "job1", "viewer")

        asyncio.run(run())

    def test_non_owner_denied(self):
        from fastapi import HTTPException

        async def run():
            await check_job_access(_FakeRedis(owner="owner"), "job1", "attacker")

        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(run())
        self.assertEqual(ctx.exception.status_code, 403)

    def test_missing_owner_fails_closed(self):
        from fastapi import HTTPException

        async def run():
            await check_job_access(_FakeRedis(owner=None), "job1", "tok")

        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(run())
        self.assertEqual(ctx.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
