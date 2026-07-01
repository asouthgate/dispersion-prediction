"""Tests for raster router error handling."""

import sys
import os
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class RasterServingTests(unittest.TestCase):

    def test_png_layer_not_found_returns_404(self):
        import asyncio
        from routers.rasters import get_raster_png

        with patch("routers.rasters._get_job_dir", return_value="/tmp/cs/no-job"):
            with patch("routers.rasters.os.path.exists", return_value=False):

                async def call():
                    return await get_raster_png("no-job", "missing")

                with self.assertRaises(Exception) as ctx:
                    asyncio.run(call())
                self.assertEqual(ctx.exception.status_code, 404)

    def test_missing_tif_returns_404(self):
        import asyncio
        from routers.rasters import get_raster_png

        def exists_side_effect(path):
            return False

        with patch("routers.rasters._get_job_dir", return_value="/tmp/cs/no-job"):
            with patch("routers.rasters.os.path.exists", side_effect=exists_side_effect):

                async def call():
                    return await get_raster_png("no-job", "missing")

                with self.assertRaises(Exception) as ctx:
                    asyncio.run(call())
                self.assertEqual(ctx.exception.status_code, 404)

    def test_tif_conversion_failure_returns_500(self):
        import asyncio
        from routers.rasters import get_raster_png

        def exists_side_effect(path):
            return path.endswith(".tif")

        with patch("routers.rasters._get_job_dir", return_value="/tmp/cs/job"):
            with patch("routers.rasters.os.path.exists", side_effect=exists_side_effect):
                with patch("routers.rasters.os.makedirs", return_value=None):
                    with patch("services.raster_service.get_bounds_for_tif", return_value=(0, 0, 1, 1)):
                        with patch("services.raster_service.tif_to_png", side_effect=OSError("bad tif")):

                            async def call():
                                return await get_raster_png("job", "bad-layer")

                            with self.assertRaises(Exception) as ctx:
                                asyncio.run(call())
                            self.assertEqual(ctx.exception.status_code, 500)

    def test_download_missing_job_dir_returns_404(self):
        import asyncio
        from routers.rasters import download_results

        with patch("routers.rasters.os.path.isdir", return_value=False):

            async def call():
                return await download_results("no-job")

            with self.assertRaises(Exception) as ctx:
                asyncio.run(call())
            self.assertEqual(ctx.exception.status_code, 404)

    def test_download_no_files_returns_404(self):
        import asyncio
        from routers.rasters import download_results

        with patch("routers.rasters.os.path.isdir", return_value=True):
            with patch("routers.rasters.os.listdir", return_value=[]):

                async def call():
                    return await download_results("empty-job")

                with self.assertRaises(Exception) as ctx:
                    asyncio.run(call())
                self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
