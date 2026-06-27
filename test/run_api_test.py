#!/usr/bin/env python3
"""
Run the resistance pipeline via the API and download all results.

Usage:
  python test/run_api_test.py --api-base http://localhost:8000 --out tmp/api-output/
"""

import argparse
import json
import os
import sys
import time
import urllib.request
from typing import Any

DEFAULT_API = os.environ.get("API_BASE", "http://localhost:8000")
POLL_INTERVAL = 2
MAX_POLLS = 300

TEST_ROOST = {
    "lng": -3.590523,
    "lat": 50.586362,
    "radiusMeters": 500,
}
TEST_LAMPS = [
    {"x": 287873.325439147, "y": 77461.9675986236, "z": 13.75240803486668},
    {"x": 287893.367871968, "y": 77697.2010264872, "z": 3.80323218042031},
    {"x": 287307.525581308, "y": 77891.2050224375, "z": 14.85559247597121},
    {"x": 287797.402863461, "y": 77279.8859419068, "z": 14.30668702325784},
    {"x": 287627.570967004, "y": 77466.0635402892, "z": 3.07168825529516},
    {"x": 287517.186354217, "y": 77896.0130704800, "z": 8.68475319654681},
    {"x": 287712.929483177, "y": 77930.4037855472, "z": 7.07264507235959},
    {"x": 287171.199937514, "y": 77155.7386254892, "z": 13.77459570183419},
    {"x": 287641.293061362, "y": 77477.4973734049, "z": 7.81060516531579},
    {"x": 287684.558305633, "y": 77554.2994716205, "z": 12.86805537994951},
]
RESOLUTION = 10.0


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
    with urllib.request.urlopen(url, timeout=60) as resp:
        return resp.read()


def main():
    parser = argparse.ArgumentParser(description="API resistance pipeline test")
    parser.add_argument("--api-base", default=DEFAULT_API, help="API base URL")
    parser.add_argument("--out", default="tmp/api-output", help="Output directory")
    args = parser.parse_args()
    base = args.api_base.rstrip("/")
    out_dir = args.out

    os.makedirs(out_dir, exist_ok=True)

    print("=== API Resistance Pipeline Test ===")
    print(f"API: {base}")
    print(f"Output: {out_dir}")

    # 1. Health check
    print("\n[1/4] Checking API health...")
    try:
        health = api_get(f"{base}/api/health")
        assert health["status"] == "ok", f"Health check failed: {health}"
        print("  OK")
    except Exception as e:
        print(f"  FAIL: {e}")
        sys.exit(1)

    # 2. Start pipeline
    print("\n[2/4] Starting resistance pipeline...")
    payload = {
        "roost": TEST_ROOST,
        "features": [],
        "lamps": TEST_LAMPS,
        "params": {"resolution": RESOLUTION},
    }
    try:
        start = api_post(f"{base}/api/pipeline/resistance", payload)
        job_id = start["job_id"]
        print(f"  Job ID: {job_id}")
    except Exception as e:
        print(f"  FAIL: {e}")
        print(f"  Payload: {json.dumps(payload, indent=2)}")
        sys.exit(1)

    with open(os.path.join(out_dir, ".job_id"), "w") as f:
        f.write(job_id)

    # 3. Poll until complete
    print(f"\n[3/4] Polling (max {MAX_POLLS * POLL_INTERVAL}s)...")
    status = None
    for i in range(MAX_POLLS):
        time.sleep(POLL_INTERVAL)
        try:
            job = api_get(f"{base}/api/pipeline/{job_id}")
        except Exception as e:
            print(f"  [{i+1}] Poll error: {e}", file=sys.stderr)
            continue

        status = job["status"]
        progress = job.get("progress", 0)
        label = job.get("progress_label", "")
        bar = "#" * int(progress * 30) + "-" * (30 - int(progress * 30))
        print(f"  [{i+1:>3}] [{bar}] {status:>9s} {label}")

        if status in ("completed", "failed", "cancelled"):
            break

    if status == "failed":
        error = job.get("error", "unknown")
        print(f"\n  FAIL: {error}")
        sys.exit(1)
    elif status != "completed":
        print(f"\n  FAIL: terminal status never reached (last: {status})")
        sys.exit(1)

    print("  OK: Pipeline completed")

    # 4. Download results via HTTP (validates API serving)
    print(f"\n[4/4] Downloading results to {out_dir}/http/")
    http_dir = os.path.join(out_dir, "http")
    os.makedirs(http_dir, exist_ok=True)
    layers = job.get("layers", [])
    if not layers:
        print("  WARNING: No layers returned")

    for layer in layers:
        url = layer["url"]
        if not url.startswith("http"):
            url = f"{base}{url}"

        fname = os.path.basename(url)
        fpath = os.path.join(http_dir, fname)

        try:
            data = api_get_bytes(url)
            with open(fpath, "wb") as f:
                f.write(data)
            size_kb = len(data) / 1024
            print(f"  {fname:<30s} {size_kb:>6.1f} KB")
        except Exception as e:
            print(f"  {fname:<30s} FAILED: {e}")

    # Download ZIP bundle
    print(f"\n  Downloading results.zip ...", end=" ")
    try:
        data = api_get_bytes(f"{base}/api/rasters/{job_id}/download")
        zip_path = os.path.join(http_dir, "results.zip")
        with open(zip_path, "wb") as f:
            f.write(data)
        print(f"OK ({len(data) / 1024:.1f} KB)")
    except Exception as e:
        print(f"FAILED: {e}")

    print(f"\nDone. Results saved to {out_dir}/")


if __name__ == "__main__":
    main()
