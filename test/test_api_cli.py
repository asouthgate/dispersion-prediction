#!/usr/bin/env python3
"""
Test 3: CLI integration script.
Calls the API directly, polls for completion, and downloads result images.

Prerequisites:
  1. Stack must be running (docker compose up -d)
  2. Seed data must be loaded (python test/run-test-stack.py seed)

Usage:
  python test/test_api_cli.py                    # use default API and settings
  python test/test_api_cli.py --lng -3.6 --lat 50.604 --radius 1000
  python test/test_api_cli.py --stage coverage --out ./my_results/
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


def run_pipeline(
    base: str,
    stage: str,
    roost: dict[str, Any] | None,
    features: list[dict[str, Any]],
    lamps: list[dict[str, Any]],
    params: dict[str, float],
) -> dict[str, Any]:
    payload = {
        "roost": roost,
        "features": features,
        "lamps": lamps,
        "params": params,
    }

    print(f"\nStarting {stage} pipeline...")
    print(f"  Roost: {roost}")
    print(f"  Params: {params}")

    start = api_post(f"{base}/api/pipeline/{stage}", payload)
    job_id = start["job_id"]
    print(f"  Job ID: {job_id}")

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
        print(f"  [{i+1:>3}] [{bar}] {status:>9s} {label}", end="\r")

        if status in ("completed", "failed", "cancelled"):
            print()
            break

    if job["status"] == "failed":
        print(f"\nPipeline FAILED: {job.get('error', 'unknown error')}")
        sys.exit(1)
    elif job["status"] == "cancelled":
        print("\nPipeline was cancelled.")
        sys.exit(1)
    elif job["status"] != "completed":
        print("\nPipeline TIMED OUT.")
        sys.exit(1)

    layers = job.get("layers", [])
    print(f"\nPipeline COMPLETED: {len(layers)} layer(s)")
    return {"job_id": job_id, "layers": layers}


def download_images(base: str, job_id: str, layers: list[dict[str, Any]], out_dir: str):
    os.makedirs(out_dir, exist_ok=True)

    for layer in layers:
        url = layer["url"]
        if not url.startswith("http"):
            url = f"{base}{url}"

        fname = f"{job_id[:8]}_{layer['id']}.png"
        fpath = os.path.join(out_dir, fname)

        print(f"  Downloading {layer['id']} -> {fname} ...", end=" ")
        try:
            data = api_get_bytes(url)
            with open(fpath, "wb") as f:
                f.write(data)
            size_kb = len(data) / 1024
            print(f"OK ({size_kb:.1f} KB)")
        except Exception as e:
            print(f"FAILED: {e}")


def main():
    parser = argparse.ArgumentParser(
        description="CLI integration script — run a pipeline and download results",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python test/test_api_cli.py
  python test/test_api_cli.py --lng -3.5767 --lat 50.5955 --radius 500
  python test/test_api_cli.py --stage resistance --resolution 20
  python test/test_api_cli.py --out ./my_results/
""",
    )

    parser.add_argument("--api-base", default=DEFAULT_API, help="API base URL")
    parser.add_argument("--stage", default="coverage", choices=["coverage", "resistance", "current"], help="Pipeline stage to run")
    parser.add_argument("--lng", type=float, default=-3.590523, help="Roost longitude (WGS84)")
    parser.add_argument("--lat", type=float, default=50.586362, help="Roost latitude (WGS84)")
    parser.add_argument("--radius", type=float, default=500, help="Roost radius in metres")
    parser.add_argument("--resolution", type=float, default=10.0, help="Raster resolution in m/px")
    parser.add_argument("--out", default=None, help="Output directory for downloaded images")

    args = parser.parse_args()
    base = args.api_base.rstrip("/")
    out_dir = args.out or os.path.join(os.path.dirname(__file__), "output")

    print("=== Test 3: CLI Integration Script ===")
    print(f"API: {base}")
    print(f"Stage: {args.stage}")
    print(f"Output: {out_dir}")

    roost = {
        "lng": args.lng,
        "lat": args.lat,
        "radiusMeters": args.radius,
    }

    result = run_pipeline(
        base, args.stage, roost, [], [], {"resolution": args.resolution},
    )

    layers = result["layers"]
    if layers:
        print(f"\nLayers:")
        for l in layers:
            b = l["bounds"]
            w_deg = abs(b[2] - b[0])
            h_deg = abs(b[3] - b[1])
            mid_lat = (b[1] + b[3]) / 2
            import math
            deg_to_m = 111_320 * math.cos(math.radians(mid_lat))
            w_km = w_deg * deg_to_m / 1000
            h_km = h_deg * 111_320 / 1000
            print(f"  {l['id']:<10s}  ~{w_km:.1f}km × ~{h_km:.1f}km  ({l['url']})")

        print(f"\nDownloading images to {out_dir}/ ...")
        download_images(base, result["job_id"], layers, out_dir)
    else:
        print("\nNo result layers to download.")

    print(f"\nDone. Results in: {out_dir}/")


if __name__ == "__main__":
    main()
