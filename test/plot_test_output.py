#!/usr/bin/env python3
"""Plot all R pipeline test output GeoTIFFs in a multi-panel figure.

Usage:  python3 test/plot_test_output.py
Output: test/output/test_output/overview.png
"""

import os
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.warp import transform_bounds

DDIR = Path(__file__).resolve().parent / "output" / "test_output"

LAYERS = [
    ("road_res", "Road Resistance", "inferno", 10),
    ("river_res", "River Resistance", "inferno", 2000),
    ("landscape_res", "Landscape Res.", "inferno", None),
    ("linear_res", "Linear Resistance", "inferno", None),
    ("lamp_res", "Lamp Resistance", "inferno", None),
    ("buildings", "Buildings Mask", "gray_r", 1),
    ("soft_surf", "Soft Surface (m)", "terrain", None),
    ("hard_surf", "Hard Surface (m)", "terrain", None),
    ("log_point_irradiance", "Log Irradiance", "inferno", None),
    ("total_res", "Total Resistance", "inferno", None),
    ("manhedge", "Managed Hedge Dist.", "viridis", None),
    ("unmanhedge", "Unmanaged Hedge Dist.", "viridis", None),
    ("tree", "Tree Distance", "viridis", None),
]

FALLBACK_CRS = CRS.from_epsg(27700)


def _read_layer(name: str):
    path = DDIR / f"{name}.tif"
    if not path.exists():
        return None, None, None

    with rasterio.open(path) as src:
        data = src.read(1).astype(np.float64)

        if src.crs is None:
            crs = FALLBACK_CRS
        else:
            crs = src.crs

        left, bottom, right, top = src.bounds
        if crs.to_epsg() == 27700:
            left, bottom, right, top = transform_bounds(crs, "EPSG:4326", left, bottom, right, top)
        bounds = (left, right, bottom, top)

        if src.nodata is not None:
            ndv = float(src.nodata)
            mask = np.isclose(data, ndv, atol=1e30) | (data < -1e20) | (data > 1e20)
            data = np.where(mask, np.nan, data)

    return data, bounds, crs


def _plot_one(ax, name: str, label: str, cmap: str, vmax: float | None):
    data, bounds, crs = _read_layer(name)
    if data is None:
        ax.text(0.5, 0.5, f"{name}.tif\nnot found", transform=ax.transAxes,
                ha="center", va="center", fontsize=9, color="gray")
        ax.set_title(label, fontsize=8)
        return

    finites = data[np.isfinite(data)]
    if len(finites) == 0:
        ax.text(0.5, 0.5, "all NaN / nodata", transform=ax.transAxes,
                ha="center", va="center", fontsize=8, color="gray")
        ax.set_title(f"{label} (no data)", fontsize=8)
        return

    vmin = np.nanmin(finites)
    vmax_val = vmax if vmax is not None else np.nanmax(finites)
    if vmin == vmax_val:
        vmax_val = vmin + 1

    im = ax.imshow(data, extent=bounds, origin="upper", cmap=cmap,
                   vmin=vmin, vmax=vmax_val, aspect="auto")
    cbar = plt.colorbar(im, ax=ax, shrink=0.7, pad=0.02)
    cbar.ax.tick_params(labelsize=6)
    ax.set_title(label, fontsize=8)
    ax.set_xlabel("Longitude", fontsize=6)
    ax.set_ylabel("Latitude", fontsize=6)
    ax.tick_params(labelsize=6)


def main():
    existing = [l for l in LAYERS if (DDIR / f"{l[0]}.tif").exists()]
    n = len(existing)
    if n == 0:
        print(f"ERROR: no GeoTIFFs found in {DDIR}")
        return

    cols = min(4, n)
    rows = (n + cols - 1) // cols

    fig, axes = plt.subplots(rows, cols, figsize=(4 * cols, 3.5 * rows))
    flat_axes = axes.flatten() if hasattr(axes, "flatten") else [axes]

    for i, (name, label, cmap, vmax) in enumerate(existing):
        _plot_one(flat_axes[i], name, label, cmap, vmax)

    for j in range(n, len(flat_axes)):
        flat_axes[j].set_visible(False)

    fig.suptitle("R Pipeline Test Output — SX87ne resistance layers (WGS84)", fontsize=12, fontweight="bold")
    plt.tight_layout()

    out = DDIR / "overview.png"
    fig.savefig(out, dpi=150, bbox_inches="tight")
    print(f"Saved: {out}  ({n} layers)")


if __name__ == "__main__":
    main()
