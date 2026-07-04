"""PMTiles router: serves .pmtiles files with HTTP Range support and auth."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import Response

from middleware.auth import require_auth
from config import PMTILES_DIR

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pmtiles", tags=["pmtiles"])


@router.get("/{filename}")
async def serve_pmtiles(
    filename: str,
    request: Request,
    token: str = Depends(require_auth),
):
    """Serve a .pmtiles file with HTTP Range request support.

    Auth is via Bearer token (same as pipeline endpoints).
    """
    pmtiles_path = Path(PMTILES_DIR) / filename

    if not pmtiles_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"PMTiles file not found: {filename}",
        )

    if not pmtiles_path.suffix == ".pmtiles":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only .pmtiles files are served",
        )

    file_size = pmtiles_path.stat().st_size
    range_header = request.headers.get("range")

    if range_header:
        range_match = range_header.strip().lower()
        if range_match.startswith("bytes="):
            try:
                range_str = range_match[6:]
                range_parts = range_str.split("-")
                start = int(range_parts[0])
                end = int(range_parts[1]) if range_parts[1] else file_size - 1
            except (ValueError, IndexError):
                raise HTTPException(
                    status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
                    detail=f"Invalid range header: {range_header}",
                )

            if start >= file_size:
                raise HTTPException(
                    status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
                    detail=f"Range start {start} exceeds file size {file_size}",
                )

            end = min(end, file_size - 1)
            length = end - start + 1

            with open(pmtiles_path, "rb") as f:
                f.seek(start)
                data = f.read(length)

            return Response(
                content=data,
                status_code=206,
                headers={
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Content-Length": str(length),
                    "Accept-Ranges": "bytes",
                    "Content-Type": "application/vnd.pmtiles",
                },
            )

    with open(pmtiles_path, "rb") as f:
        data = f.read()

    return Response(
        content=data,
        status_code=200,
        headers={
            "Accept-Ranges": "bytes",
            "Content-Length": str(file_size),
            "Content-Type": "application/vnd.pmtiles",
        },
    )
