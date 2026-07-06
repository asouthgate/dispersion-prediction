"""PMTiles router: serves .pmtiles files with HTTP Range support and auth."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse

from middleware.auth import require_auth
from config import PMTILES_DIR

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pmtiles", tags=["pmtiles"])


@router.get("/{filename}")
async def serve_pmtiles(
    filename: str,
    token: str = Depends(require_auth),
):
    """Serve a .pmtiles file with HTTP Range request support.

    Auth is via Bearer token (same as pipeline endpoints).
    Uses FileResponse which handles Range headers natively.
    """
    safe_name = Path(filename).name

    if not safe_name.endswith(".pmtiles"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only .pmtiles files are served",
        )

    pmtiles_path = (Path(PMTILES_DIR) / safe_name).resolve()
    if not str(pmtiles_path).startswith(str(Path(PMTILES_DIR).resolve())):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"PMTiles file not found: {filename}",
        )

    if not pmtiles_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"PMTiles file not found: {filename}",
        )

    return FileResponse(
        pmtiles_path,
        media_type="application/vnd.pmtiles",
        headers={"Accept-Ranges": "bytes"},
    )
