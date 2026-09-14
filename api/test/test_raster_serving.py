"""Tests for raw raster router error handling."""

import sys
import os
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class RasterServingTests(unittest.TestCase):

    def test_missing_tif_returns_404(self):
        import asyncio
        from routers.rasters import get_raw_tif

        with patch("routers.rasters.get_redis", return_value=AsyncMock()), \
             patch("routers.rasters.check_job_access", new=AsyncMock()), \
             patch("routers.rasters._get_job_dir", return_value="/tmp/cs/no-job"), \
             patch("routers.rasters.os.path.exists", return_value=False):

            async def call():
                return await get_raw_tif("no-job", "missing", token="owner")

            with self.assertRaises(Exception) as ctx:
                asyncio.run(call())
            self.assertEqual(ctx.exception.status_code, 404)

    def test_invalid_layer_name_returns_400(self):
        import asyncio
        from routers.rasters import get_raw_tif

        with patch("routers.rasters.get_redis", return_value=AsyncMock()), \
             patch("routers.rasters.check_job_access", new=AsyncMock()):

            async def call():
                return await get_raw_tif("job", "../etc/passwd", token="owner")

            with self.assertRaises(Exception) as ctx:
                asyncio.run(call())
            self.assertEqual(ctx.exception.status_code, 400)

    def test_access_denied_returns_403(self):
        import asyncio
        from fastapi import HTTPException
        from routers.rasters import get_raw_tif

        async def deny(redis, job_id, token):
            raise HTTPException(status_code=403, detail="You can only view your own jobs")

        with patch("routers.rasters.get_redis", return_value=AsyncMock()), \
             patch("routers.rasters.check_job_access", new=deny):

            async def call():
                return await get_raw_tif("job", "dtm", token="attacker")

            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(call())
            self.assertEqual(ctx.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
