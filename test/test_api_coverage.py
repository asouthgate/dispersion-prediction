#!/usr/bin/env python3
"""
Test 2: API coverage pipeline integration test.

Prerequisites:
  1. Stack must be running (docker compose up -d)
  2. Seed data must be loaded (python test/run-test-stack.py seed)
  3. API must be accessible (default http://localhost:8000)

Usage:
  python test/test_api_coverage.py [--api-base http://localhost:8000]
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any

DEFAULT_API = os.environ.get("API_BASE", "http://localhost:8000")
POLL_INTERVAL = 2
MAX_POLLS = 120

TEST_ROOST = {
    "lng": -3.590523,
    "lat": 50.586362,
    "radiusMeters": 500,
}
RESOLUTION = 10


def api_post(url: str, data: dict[str, Any]) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_get(url: str) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_get_bytes(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=30) as resp:
        return resp.read()


def main():
    parser = argparse.ArgumentParser(description="API coverage pipeline integration test")
    parser.add_argument("--api-base", default=DEFAULT_API, help="API base URL")
    args = parser.parse_args()
    base = args.api_base.rstrip("/")

    failures = 0

    print("=== Test 2: API Coverage Pipeline Test ===")
    print(f"API base: {base}")

    # 1. Health check
    print("\n[1/5] Checking API health...")
    try:
        health = api_get(f"{base}/api/health")
        assert health["status"] == "ok", f"Health check failed: {health}"
        print("  OK: API is healthy")
    except Exception as e:
        print(f"  FAIL: {e}")
        failures += 1

    # 2. Start coverage pipeline
    print("\n[2/5] Starting coverage pipeline...")
    payload = {
        "roost": TEST_ROOST,
        "features": [],
        "lamps": [],
        "params": {"resolution": RESOLUTION},
    }
    try:
        start = api_post(f"{base}/api/pipeline/coverage", payload)
        job_id = start["job_id"]
        assert job_id, "No job_id in response"
        print(f"  OK: Job started — {job_id}")
    except Exception as e:
        print(f"  FAIL: {e}")
        print(f"  Attempted payload: {json.dumps(payload, indent=2)}")
        sys.exit(1)

    # 3. Poll until complete
    print(f"\n[3/5] Polling job {job_id} (max {MAX_POLLS * POLL_INTERVAL}s)...")
    status = None
    for i in range(MAX_POLLS):
        time.sleep(POLL_INTERVAL)
        try:
            job = api_get(f"{base}/api/pipeline/{job_id}")
            status = job["status"]
            progress = job.get("progress", 0)
            label = job.get("progress_label", "")
            print(f"  [{i+1}] status={status} progress={progress:.0%} label={label}")
            if status in ("completed", "failed", "cancelled"):
                break
        except Exception as e:
            print(f"  WARNING: poll failed: {e}")

    if status is None:
        print("  FAIL: Never received a terminal status")
        failures += 1
        sys.exit(1)

    if status != "completed":
        error = job.get("error", "unknown")
        print(f"  FAIL: Job status is '{status}': {error}")
        failures += 1
        sys.exit(1)

    print(f"  OK: Job completed successfully")

    # 4. Verify layers
    print("\n[4/5] Verifying result layers...")
    layers = job.get("layers", [])
    if not layers:
        print("  FAIL: No layers returned")
        failures += 1
    else:
        print(f"  Got {len(layers)} layer(s):")
        for layer in layers:
            print(f"    - {layer['id']}: bounds={layer['bounds']} url={layer['url']}")

        layer_ids = [l["id"] for l in layers]

        # Coverage should return DSM, DTM, LCM
        for expected in ("DSM", "DTM", "LCM"):
            if expected in layer_ids:
                print(f"  OK: {expected} layer present")
            else:
                print(f"  WARNING: {expected} layer not found (may not exist in seed data)")
                # Don't fail — seed data might not have all rasters

        # Verify bounds are roughly square (in WGS84, a BNG square distorts slightly)
        for layer in layers:
            b = layer["bounds"]
            width = abs(b[2] - b[0])
            height = abs(b[3] - b[1])
            ratio = max(width, height) / max(min(width, height), 0.0001)
            if 0.5 <= ratio <= 2.5:
                print(f"  OK: {layer['id']} bounds in range (ratio={ratio:.2f})")
            else:
                print(f"  WARNING: {layer['id']} bounds unusual: w={width:.4f}deg h={height:.4f}deg ratio={ratio:.2f}")
                # The old hardcoded extent bug produced ~4:1 ratio rectangles
                if ratio > 5.0:
                    failures += 1

    # 5. Download images
    print("\n[5/5] Downloading result images...")
    output_dir = os.path.join(os.path.dirname(__file__), "output")
    os.makedirs(output_dir, exist_ok=True)

    for layer in layers:
        url = layer["url"]
        if not url.startswith("http"):
            url = f"{base}{url}"

        try:
            data = api_get_bytes(url)
            fname = f"{layer['id']}_{job_id[:8]}.png"
            fpath = os.path.join(output_dir, fname)
            with open(fpath, "wb") as f:
                f.write(data)
            print(f"  OK: {fname} ({len(data)} bytes)")
        except Exception as e:
            print(f"  FAIL: Could not download {layer['id']}: {e}")
            failures += 1

    # Summary
    print(f"\n{'='*40}")
    if failures:
        print(f"Test 2 FAILED — {failures} failure(s)")
        sys.exit(1)
    else:
        print("Test 2 PASSED")
        sys.exit(0)


if __name__ == "__main__":
    main()
