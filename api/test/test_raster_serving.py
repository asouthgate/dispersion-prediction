"""Tests for raster router error handling."""

import sys
import os
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class RasterServingTests(unittest.TestCase):

    def test_png_layer_not_found_returns_404(self):
        import asyncio
        from routers.rasters import get_raster_png

        with patch("routers.rasters.get_redis", return_value=AsyncMock()):
            with patch("routers.rasters.check_job_access", new=AsyncMock()):
                with patch("routers.rasters._get_job_dir", return_value="/tmp/cs/no-job"):
                    with patch("routers.rasters.os.path.exists", return_value=False):

                        async def call():
                            return await get_raster_png("no-job", "missing", token="owner")

                        with self.assertRaises(Exception) as ctx:
                            asyncio.run(call())
                        self.assertEqual(ctx.exception.status_code, 404)

    def test_missing_tif_returns_404(self):
        import asyncio
        from routers.rasters import get_raster_png

        def exists_side_effect(path):
            return False

        with patch("routers.rasters.get_redis", return_value=AsyncMock()):
            with patch("routers.rasters.check_job_access", new=AsyncMock()):
                with patch("routers.rasters._get_job_dir", return_value="/tmp/cs/no-job"):
                    with patch("routers.rasters.os.path.exists", side_effect=exists_side_effect):

                        async def call():
                            return await get_raster_png("no-job", "missing", token="owner")

                        with self.assertRaises(Exception) as ctx:
                            asyncio.run(call())
                        self.assertEqual(ctx.exception.status_code, 404)

    def test_tif_conversion_failure_returns_500(self):
        import asyncio
        from routers.rasters import get_raster_png

        def exists_side_effect(path):
            return path.endswith(".tif")

        with patch("routers.rasters.get_redis", return_value=AsyncMock()):
            with patch("routers.rasters.check_job_access", new=AsyncMock()):
                with patch("routers.rasters._get_job_dir", return_value="/tmp/cs/job"):
                    with patch("routers.rasters.os.path.exists", side_effect=exists_side_effect):
                        with patch("routers.rasters.os.makedirs", return_value=None):
                            with patch("services.raster_service.get_bounds_for_tif", return_value=(0, 0, 1, 1)):
                                with patch("services.raster_service.tif_to_png", side_effect=OSError("bad tif")):

                                    async def call():
                                        return await get_raster_png("job", "dtm", token="owner")

                                    with self.assertRaises(Exception) as ctx:
                                        asyncio.run(call())
                                    self.assertEqual(ctx.exception.status_code, 500)

    def test_access_denied_returns_403(self):
        import asyncio
        from fastapi import HTTPException
        from routers.rasters import get_raster_png

        async def deny(redis, job_id, token):
            raise HTTPException(status_code=403, detail="You can only view your own jobs")

        with patch("routers.rasters.get_redis", return_value=AsyncMock()):
            with patch("routers.rasters.check_job_access", new=deny):

                async def call():
                    return await get_raster_png("job", "dtm", token="attacker")

                with self.assertRaises(HTTPException) as ctx:
                    asyncio.run(call())
                self.assertEqual(ctx.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
