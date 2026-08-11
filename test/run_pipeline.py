#!/usr/bin/env python3
"""
Run a pipeline stage via the API and download all results.

Usage:
  python test/run_pipeline.py
  python test/run_pipeline.py --stage resistance --out tmp/api-output/
  python test/run_pipeline.py --stage current --lng -3.6 --lat 50.604 --radius 1000
"""

import argparse
import json
import math
import os
import sys
import time
import urllib.request
from typing import Any

DEFAULT_API = os.environ.get("API_BASE", "http://localhost:8084")
POLL_INTERVAL = 2
MAX_POLLS = 300

_session_token: str | None = None


def get_token(base: str) -> str:
    global _session_token
    if _session_token:
        return _session_token
    time.sleep(6) # required for rate limiting
    req = urllib.request.Request(
        f"{base}/api/auth/token",
        data=b"",
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        _session_token = data["token"]
        return _session_token


def auth_header(base: str) -> dict[str, str]:
    token = get_token(base)
    return {"Authorization": f"Bearer {token}"}

TEST_ROOST = {
    "lng": -3.590523,
    "lat": 50.586362,
    "radiusMeters": 500,
}
TEST_LIGHT_FEATURES = [
    {
        "id": f"lamp-{i}",
        "category": "Lights",
        "label": f"Test Lamp {i}",
        "geometryKind": "point",
        "geojson": {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lamp["x"], lamp["y"]]},
            "properties": {},
        },
        "data": {"height": lamp["z"]},
    }
    for i, lamp in enumerate([
        {"x": -3.588806, "y": 50.585817, "z": 13.75},
        {"x": -3.590015, "y": 50.587899, "z": 3.80},
        {"x": -3.592614, "y": 50.589625, "z": 14.86},
        {"x": -3.589386, "y": 50.584292, "z": 14.31},
        {"x": -3.590520, "y": 50.585968, "z": 3.07},
        {"x": -3.591261, "y": 50.589702, "z": 8.68},
        {"x": -3.589848, "y": 50.589997, "z": 7.07},
        {"x": -3.593511, "y": 50.583249, "z": 13.77},
        {"x": -3.590434, "y": 50.586050, "z": 7.81},
        {"x": -3.590181, "y": 50.586721, "z": 12.87},
    ])
]


def api_post(url: str, data: dict[str, Any]) -> dict[str, Any]:
    headers = {"Content-Type": "application/json"}
    if _session_token:
        headers["Authorization"] = f"Bearer {_session_token}"
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_get(url: str) -> dict[str, Any]:
    headers = {}
    if _session_token:
        headers["Authorization"] = f"Bearer {_session_token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_get_bytes(url: str) -> bytes:
    headers = {}
    if _session_token:
        headers["Authorization"] = f"Bearer {_session_token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def check_health(base: str):
    print("\n[1/4] Checking API health...")
    try:
        health = api_get(f"{base}/api/health")
        assert health["status"] == "ok", f"Health check failed: {health}"
        print("  OK")
    except Exception as e:
        print(f"  FAIL: {e}")
        sys.exit(1)

    print("  Acquiring session token...")
    try:
        get_token(base)
        print("  Token acquired")
    except Exception as e:
        print(f"  FAIL: {e}")
        sys.exit(1)


def run_pipeline(
    base: str,
    stage: str,
    roost: dict[str, Any],
    features: list[dict[str, Any]],
    params: dict[str, float],
) -> dict[str, Any]:
    payload = {
        "roost": roost,
        "features": features,
        "params": params,
    }

    print(f"\n[2/4] Starting {stage} pipeline...")
    print(f"  Roost: {roost}")
    print(f"  Features: {len(features)}")
    print(f"  Params: {params}")

    start = api_post(f"{base}/api/pipeline/{stage}", payload)
    job_id = start["job_id"]
    print(f"  Job ID: {job_id}")

    print(f"\n[3/4] Polling (max {MAX_POLLS * POLL_INTERVAL}s)...")
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

    if job["status"] == "failed":
        print(f"\n  FAIL: {job.get('error', 'unknown error')}")
        sys.exit(1)
    elif job["status"] == "cancelled":
        print("\n  FAIL: Pipeline was cancelled.")
        sys.exit(1)
    elif job["status"] != "completed":
        print(f"\n  FAIL: terminal status never reached (last: {job['status']})")
        sys.exit(1)

    layers = job.get("layers", [])
    print(f"  OK: Pipeline completed with {len(layers)} layer(s)")
    return {"job_id": job_id, "layers": layers}


def download_results(base: str, job_id: str, layers: list[dict[str, Any]], out_dir: str):
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


def display_layer_info(layers: list[dict[str, Any]]):
    if not layers:
        print("\n  No result layers.")
        return

    print(f"\n  Layers:")
    for l in layers:
        b = l["bounds"]
        w_deg = abs(b[2] - b[0])
        h_deg = abs(b[3] - b[1])
        mid_lat = (b[1] + b[3]) / 2
        deg_to_m = 111_320 * math.cos(math.radians(mid_lat))
        w_km = w_deg * deg_to_m / 1000
        h_km = h_deg * 111_320 / 1000
        print(f"    {l['id']:<10s}  ~{w_km:.1f}km x ~{h_km:.1f}km  ({l['url']})")


def main():
    parser = argparse.ArgumentParser(
        description="Run a pipeline stage via the API and download results",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python test/run_pipeline.py
  python test/run_pipeline.py --stage current --out ./my_results/
  python test/run_pipeline.py --lng -3.5767 --lat 50.5955 --radius 500
""",
    )

    parser.add_argument("--api-base", default=DEFAULT_API, help="API base URL")
    parser.add_argument("--stage", default="resistance", choices=["coverage", "resistance", "current"], help="Pipeline stage to run")
    parser.add_argument("--lng", type=float, default=TEST_ROOST["lng"], help="Roost longitude (WGS84)")
    parser.add_argument("--lat", type=float, default=TEST_ROOST["lat"], help="Roost latitude (WGS84)")
    parser.add_argument("--radius", type=float, default=TEST_ROOST["radiusMeters"], help="Roost radius in metres")
    parser.add_argument("--resolution", type=float, default=10.0, help="Raster resolution in m/px")
    parser.add_argument("--out", default=None, help="Output directory for downloaded results")

    args = parser.parse_args()
    base = args.api_base.rstrip("/")
    out_dir = args.out or os.path.join(os.path.dirname(__file__), "output", args.stage)

    print("=== Pipeline API Test ===")
    print(f"API: {base}")
    print(f"Stage: {args.stage}")
    print(f"Output: {out_dir}")

    roost = {
        "lng": args.lng,
        "lat": args.lat,
        "radiusMeters": args.radius,
    }

    check_health(base)

    result = run_pipeline(
        base, args.stage, roost, TEST_LIGHT_FEATURES, {"resolution": args.resolution},
    )

    display_layer_info(result["layers"])

    if result["layers"]:
        print(f"\n[4/4] Downloading results to {out_dir}/ ...")
        download_results(base, result["job_id"], result["layers"], out_dir)

    with open(os.path.join(out_dir, ".job_id"), "w") as f:
        f.write(result["job_id"])

    print(f"\nDone. Results in: {out_dir}/")


if __name__ == "__main__":
    main()
