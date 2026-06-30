#!/usr/bin/env python3
"""Visualize seed GIS data: DTM, DSM, LCM with vector overlays.

Reads GeoTIFFs and shapefiles directly from test/data/seed/gis/,
merges multi-tile rasters, and produces a coverage plot.

Usage:  python3 test/plot_seed_data.py
Output: test/data/seed/coverage.png
"""

import os
from pathlib import Path

import fiona
import matplotlib.pyplot as plt
import numpy as np
import rasterio
from rasterio.merge import merge as merge_rasters
from rasterio.plot import show as show_raster
from shapely.geometry import shape

SEED = Path(__file__).resolve().parent / "data" / "seed" / "gis"


def _merge_tifs(pattern: str, mask_nodata: bool = True):
    """Merge all GeoTIFFs matching *pattern* in SEED/<folder>/ into a single array."""
    folder = SEED / pattern
    if not folder.is_dir():
        return None, None

    tifs = sorted(folder.glob("*.tif"))
    if not tifs:
        return None, None

    datasets = [rasterio.open(p) for p in tifs]
    arr, transform = merge_rasters(datasets, method="first", nodata=np.nan)
    bounds = rasterio.transform.array_bounds(arr.shape[0], arr.shape[1], transform)
    crs = datasets[0].crs
    for ds in datasets:
        ds.close()

    if mask_nodata:
        arr = np.where(arr == -3.4028235e38, np.nan, arr)
        arr = np.where(arr == 0, np.nan, arr)

    return arr[0], (transform, bounds, crs)


def _read_vector(name: str):
    """Read a shapefile, return list of shapely geometries."""
    shp = SEED / name / f"{name}.shp"
    if not shp.exists():
        return []
    geoms = []
    with fiona.open(shp) as src:
        for feat in src:
            geoms.append(shape(feat["geometry"]))
    return geoms


def _add_vectors(ax, roads, rivers, buildings):
    """Overlay vectors on a matplotlib axis (BNG coordinates)."""
    for g in buildings:
        if g.exterior is not None:
            x, y = g.exterior.xy
            ax.fill(x, y, facecolor="#a0522d", edgecolor="none", alpha=0.4, linewidth=0)
    for g in roads:
        if g.geom_type in ("LineString", "MultiLineString"):
            _plot_geom(ax, g, color="#888888", lw=0.5)
    for g in rivers:
        if g.geom_type in ("LineString", "MultiLineString"):
            _plot_geom(ax, g, color="#3678b5", lw=0.6)


def _plot_geom(ax, geom, color, lw):
    if geom.geom_type == "MultiLineString":
        for part in geom.geoms:
            x, y = part.xy
            ax.plot(x, y, color=color, linewidth=lw, alpha=0.7)
    elif geom.geom_type == "LineString":
        x, y = geom.xy
        ax.plot(x, y, color=color, linewidth=lw, alpha=0.7)


def main():
    print("Reading vectors...")
    roads = _read_vector("roads")
    rivers = _read_vector("rivers")
    buildings = _read_vector("buildings")
    print(f"  roads={len(roads)} rivers={len(rivers)} buildings={len(buildings)}")

    print("Merging DTM...")
    dtm_arr, dtm_meta = _merge_tifs("dtm")
    print("Merging DSM...")
    dsm_arr, dsm_meta = _merge_tifs("dsm")
    print("Merging LCM...")
    lcm_arr, lcm_meta = _merge_tifs("lcm")

    if dtm_arr is None:
        print("ERROR: no DTM rasters found")
        return

    fig, axes = plt.subplots(2, 2, figsize=(16, 14))
    (ax1, ax2), (ax3, ax4) = axes

    transform, bounds, crs = dtm_meta
    extent = (bounds[0], bounds[2], bounds[1], bounds[3])

    # --- DTM ---
    im1 = ax1.imshow(dtm_arr, extent=extent, origin="upper",
                     cmap="terrain", aspect="equal")
    cbar1 = fig.colorbar(im1, ax=ax1, shrink=0.6)
    cbar1.set_label("Elevation (m)")
    ax1.set_title("DTM (Digital Terrain Model)")
    ax1.set_xlabel("BNG Easting (m)")
    ax1.set_ylabel("BNG Northing (m)")

    # --- DSM ---
    if dsm_arr is not None:
        im2 = ax2.imshow(dsm_arr, extent=extent, origin="upper",
                         cmap="terrain", aspect="equal")
        fig.colorbar(im2, ax=ax2, shrink=0.6).set_label("Elevation (m)")
    ax2.set_title("DSM (Digital Surface Model)")
    ax2.set_xlabel("BNG Easting (m)")

    # --- DTM + vectors ---
    ax3.imshow(dtm_arr, extent=extent, origin="upper",
               cmap="terrain", aspect="equal")
    _add_vectors(ax3, roads, rivers, buildings)
    ax3.set_title("DTM + Roads / Rivers / Buildings")
    ax3.set_xlabel("BNG Easting (m)")
    ax3.set_ylabel("BNG Northing (m)")

    # --- LCM ---
    if lcm_arr is not None:
        lcm_data = np.where(np.isnan(lcm_arr), 0, lcm_arr)
        im4 = ax4.imshow(lcm_data, extent=extent, origin="upper",
                         cmap="tab20", aspect="equal", vmin=0, vmax=20)
        fig.colorbar(im4, ax=ax4, shrink=0.6).set_label("Land cover class")
    ax4.set_title("LCM (Land Cover Map)")
    ax4.set_xlabel("BNG Easting (m)")

    fig.suptitle(f"Seed Data Coverage — SX87ne (EPSG:27700)", fontsize=14, fontweight="bold")
    plt.tight_layout()

    out = SEED / "coverage.png"
    fig.savefig(out, dpi=150, bbox_inches="tight")
    print(f"\nSaved: {out}")


if __name__ == "__main__":
    main()
