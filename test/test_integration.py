#!/usr/bin/env python3
"""
Full-stack integration test: brings up the docker compose stack, verifies
the PMTiles basemap loads correctly through the full browser-facing path
(nginx proxy → API → PMTiles file with auth).

Tests:
  1. API health check
  2. Auth token creation
  3. PMTiles endpoint via direct API (range request, magic bytes)
  4. PMTiles endpoint via nginx proxy (frontend path)
  5. Frontend page loads (HTTP 200, contains expected content)
  6. Unauthenticated PMTiles requests are rejected (both direct and via nginx)
"""

import argparse
import json
import sys
import time
import urllib.request
import urllib.error

DEFAULT_API = "http://localhost:8000"
DEFAULT_FRONTEND = "http://localhost:5180"
MAX_RETRIES = 30
RETRY_INTERVAL = 2


def wait_for_service(url, name, max_retries=MAX_RETRIES):
    print(f"  Waiting for {name}...")
    for i in range(max_retries):
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                if resp.status == 200:
                    print(f"  {name} is ready.")
                    return True
        except Exception:
            pass
        print(f"  attempt {i+1}/{max_retries}...")
        time.sleep(RETRY_INTERVAL)
    print(f"  FAIL: {name} did not become ready")
    return False


def get_token(base: str) -> str:
    req = urllib.request.Request(
        f"{base}/api/auth/token",
        data=b"",
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))["token"]


def test_api_health(base: str) -> bool:
    print("\n[1] API health check...")
    try:
        with urllib.request.urlopen(f"{base}/api/health", timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            assert data["status"] == "ok"
            print("  OK")
            return True
    except Exception as e:
        print(f"  FAIL: {e}")
        return False


def test_auth_token(base: str) -> str:
    print("\n[2] Auth token creation...")
    try:
        token = get_token(base)
        assert len(token) > 0
        print(f"  OK — token acquired ({len(token)} chars)")
        return token
    except Exception as e:
        print(f"  FAIL: {e}")
        sys.exit(1)


def test_pmtiles_direct_api(base: str, token: str) -> bool:
    print("\n[3] PMTiles endpoint (direct API)...")

    url = f"{base}/api/pmtiles/uk.pmtiles"
    req = urllib.request.Request(url, headers={"Range": "bytes=0-7", "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            assert resp.status == 206, f"Expected 206, got {resp.status}"
            assert resp.headers.get("Accept-Ranges") == "bytes", "Missing Accept-Ranges"
            assert "Content-Range" in resp.headers, "Missing Content-Range"
            data = resp.read()
            assert len(data) == 8, f"Expected 8 bytes, got {len(data)}"
            assert data[:6] == b"PMTile", f"Bad magic bytes: {data[:6]}"
            print("  OK — magic bytes verified, range requests working")
    except urllib.error.HTTPError as e:
        print(f"  FAIL: HTTP {e.code} {e.reason}")
        return False
    except AssertionError as e:
        print(f"  FAIL: {e}")
        return False

    # Unauthenticated should fail
    try:
        urllib.request.urlopen(f"{base}/api/pmtiles/uk.pmtiles", timeout=10)
        print("  FAIL: expected 401 without token")
        return False
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print("  OK — unauthenticated rejected (401)")
            return True
        print(f"  FAIL: expected 401, got {e.code}")
        return False


def test_pmtiles_via_nginx(frontend_base: str, token: str) -> bool:
    print("\n[4] PMTiles endpoint via nginx proxy (frontend path)...")

    url = f"{frontend_base}/api/pmtiles/uk.pmtiles"
    req = urllib.request.Request(url, headers={"Range": "bytes=0-7", "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            assert resp.status == 206, f"Expected 206, got {resp.status}"
            data = resp.read()
            assert len(data) == 8, f"Expected 8 bytes, got {len(data)}"
            assert data[:6] == b"PMTile", f"Bad magic bytes: {data[:6]}"
            print("  OK — PMTiles served correctly through nginx")
    except urllib.error.HTTPError as e:
        print(f"  FAIL: HTTP {e.code} {e.reason}")
        return False
    except urllib.error.URLError as e:
        print(f"  FAIL: Could not reach frontend: {e}")
        return False
    except AssertionError as e:
        print(f"  FAIL: {e}")
        return False

    # Unauthenticated via nginx should fail
    try:
        urllib.request.urlopen(f"{frontend_base}/api/pmtiles/uk.pmtiles", timeout=10)
        print("  FAIL: expected 401 without token via nginx")
        return False
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print("  OK — unauthenticated rejected via nginx (401)")
            return True
        print(f"  FAIL: expected 401, got {e.code}")
        return False


def test_frontend_page(frontend_base: str) -> bool:
    print("\n[5] Frontend page loads...")
    try:
        with urllib.request.urlopen(frontend_base, timeout=10) as resp:
            assert resp.status == 200, f"Expected 200, got {resp.status}"
            html = resp.read().decode("utf-8")
            assert "<div" in html or "<html" in html, "Page appears empty"
            assert "id=\"root\"" in html, "Missing root div"
            print(f"  OK — page loaded ({len(html)} bytes)")
            return True
    except urllib.error.HTTPError as e:
        print(f"  FAIL: HTTP {e.code} {e.reason}")
        return False
    except urllib.error.URLError as e:
        print(f"  FAIL: Could not reach frontend: {e}")
        return False
    except AssertionError as e:
        print(f"  FAIL: {e}")
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-base", default=DEFAULT_API)
    parser.add_argument("--frontend-base", default=DEFAULT_FRONTEND)
    args = parser.parse_args()
    base = args.api_base.rstrip("/")
    frontend = args.frontend_base.rstrip("/")

    print("=== Full-Stack Integration Test ===")
    print(f"API: {base}")
    print(f"Frontend: {frontend}")

    if not wait_for_service(f"{base}/api/health", "API"):
        sys.exit(1)

    results = []
    results.append(("API health", test_api_health(base)))

    token = test_auth_token(base)

    results.append(("PMTiles direct API", test_pmtiles_direct_api(base, token)))
    results.append(("PMTiles via nginx", test_pmtiles_via_nginx(frontend, token)))
    results.append(("Frontend page", test_frontend_page(frontend)))

    print("\n" + "=" * 50)
    print("Results:")
    all_pass = True
    for name, passed in results:
        status = "PASS" if passed else "FAIL"
        if not passed:
            all_pass = False
        print(f"  [{status}] {name}")

    if not all_pass:
        print("\nSome tests FAILED.")
        sys.exit(1)
    else:
        print("\nAll tests PASSED.")


if __name__ == "__main__":
    main()
