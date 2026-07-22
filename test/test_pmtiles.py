#!/usr/bin/env python3
"""
Test the PMTiles endpoint: acquire a token, request a range of the file,
and verify the response contains valid PMTiles magic bytes.

Two test modes:
  1. Direct API test (port 8000) — verifies the backend endpoint works
  2. Integration test (port 5180) — verifies the full path through nginx
     proxy, matching exactly what the frontend does in production
"""

import argparse
import sys
import urllib.request
import urllib.error
import json

DEFAULT_API = "http://localhost:8084"
DEFAULT_FRONTEND = "http://localhost:5184"
DEFAULT_PMTILES_FILE = "test.pmtiles"


def get_token(base: str) -> str:
    req = urllib.request.Request(
        f"{base}/api/auth/token",
        data=b"",
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))["token"]


def test_pmtiles_via_api(base: str, token: str, pmtiles_file: str):
    """Test the PMTiles endpoint directly against the API."""
    print(f"\n[PMTiles] Testing /api/pmtiles endpoint (direct API) [{pmtiles_file}]...")

    url = f"{base}/api/pmtiles/{pmtiles_file}"

    req = urllib.request.Request(url, headers={"Range": "bytes=0-7", "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            assert resp.status == 206, f"Expected 206, got {resp.status}"
            assert resp.headers.get("Accept-Ranges") == "bytes", "Missing Accept-Ranges header"
            assert "Content-Range" in resp.headers, "Missing Content-Range header"
            data = resp.read()
            assert len(data) == 8, f"Expected 8 bytes, got {len(data)}"
            assert data[:6] == b"PMTile", f"Invalid PMTiles magic bytes: {data[:6]}"
            print("  OK — magic bytes verified, range requests working")
    except urllib.error.HTTPError as e:
        print(f"  FAIL: HTTP {e.code} {e.reason}")
        sys.exit(1)
    except AssertionError as e:
        print(f"  FAIL: {e}")
        sys.exit(1)

    # Test without token
    no_token_url = f"{base}/api/pmtiles/{pmtiles_file}"
    try:
        urllib.request.urlopen(no_token_url, timeout=10)
        print("  FAIL: expected 401 without token")
        sys.exit(1)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print("  OK — unauthenticated request correctly rejected (401)")
        else:
            print(f"  FAIL: expected 401, got {e.code}")
            sys.exit(1)


def test_pmtiles_via_frontend(frontend_base: str, api_base: str, token: str, pmtiles_file: str):
    """Integration test: hit the frontend nginx proxy to verify the full path
    that the browser actually uses to load the PMTiles basemap."""
    print(f"\n[PMTiles] Integration test via frontend nginx proxy [{pmtiles_file}]...")

    # The frontend loads the pmtiles file through nginx's /api/ proxy
    url = f"{frontend_base}/api/pmtiles/{pmtiles_file}"

    req = urllib.request.Request(url, headers={"Range": "bytes=0-7", "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            assert resp.status == 206, f"Expected 206, got {resp.status}"
            data = resp.read()
            assert len(data) == 8, f"Expected 8 bytes, got {len(data)}"
            assert data[:6] == b"PMTile", f"Invalid PMTiles magic bytes: {data[:6]}"
            print("  OK — PMTiles served correctly through nginx proxy")
    except urllib.error.HTTPError as e:
        print(f"  FAIL: HTTP {e.code} {e.reason}")
        body = e.read().decode("utf-8", errors="replace")
        print(f"  Response: {body[:200]}")
        sys.exit(1)
    except AssertionError as e:
        print(f"  FAIL: {e}")
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"  FAIL: Could not reach frontend: {e}")
        sys.exit(1)

    # Also test that unauthenticated requests through nginx get 401
    no_token_url = f"{frontend_base}/api/pmtiles/{pmtiles_file}"
    try:
        urllib.request.urlopen(no_token_url, timeout=10)
        print("  FAIL: expected 401 without token (via nginx)")
        sys.exit(1)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print("  OK — unauthenticated request rejected via nginx (401)")
        else:
            print(f"  FAIL: expected 401, got {e.code}")
            sys.exit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-base", default=DEFAULT_API)
    parser.add_argument("--frontend-base", default=DEFAULT_FRONTEND)
    parser.add_argument("--pmtiles-file", default=DEFAULT_PMTILES_FILE)
    args = parser.parse_args()
    base = args.api_base.rstrip("/")
    frontend = args.frontend_base.rstrip("/")
    pmtiles_file = args.pmtiles_file

    token = get_token(base)

    test_pmtiles_via_api(base, token, pmtiles_file)
    test_pmtiles_via_frontend(frontend, base, token, pmtiles_file)


if __name__ == "__main__":
    main()
