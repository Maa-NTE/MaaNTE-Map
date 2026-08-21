#!/usr/bin/env python3
"""Analyze tile-set overlap and compose diagnostic map images.

The exporter numbers tiles from 10001 in row-major order. The script also
reports the best overlap offset against the checked-in z=0 JPEG tiles.
"""
from __future__ import annotations

import argparse
import math
import re
from pathlib import Path

import numpy as np
from PIL import Image


TILE_RE = re.compile(r"map_bigworld_(\d+)\.png$", re.I)


def read_tiles(directory: Path) -> tuple[int, dict[tuple[int, int], Path]]:
    files = []
    for path in directory.iterdir():
        match = TILE_RE.match(path.name)
        if match:
            files.append((int(match.group(1)), path))
    if not files:
        raise SystemExit(f"no map_bigworld_*.png files in {directory}")
    files.sort()
    start = files[0][0]
    count = len(files)
    side = math.isqrt(count)
    if side * side != count:
        raise SystemExit(f"tile count {count} is not a square")
    expected = list(range(start, start + count))
    actual = [number for number, _ in files]
    if actual != expected:
        raise SystemExit("tile numbers are not contiguous")
    return side, {(index % side, index // side): path for index, (_, path) in enumerate(files)}


def tile_vector(path: Path) -> np.ndarray:
    # A tiny signature keeps the all-offset scan fast while retaining enough
    # spatial/color information to identify the unchanged overlap.
    image = Image.open(path).convert("RGB").resize((4, 4), Image.Resampling.BILINEAR)
    return np.asarray(image, dtype=np.float32) / 255.0


def compose(directory: Path, output: Path) -> tuple[int, int]:
    side, tiles = read_tiles(directory)
    first = Image.open(next(iter(tiles.values())))
    tile_width, tile_height = first.size
    canvas = Image.new("RGB", (side * tile_width, side * tile_height))
    for (x, y), path in tiles.items():
        canvas.paste(Image.open(path).convert("RGB"), (x * tile_width, y * tile_height))
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, format="PNG", optimize=True)
    return side, tile_width


def compare_new_to_old(new_dir: Path, old_dir: Path) -> list[tuple[float, int, int]]:
    new_side, new_tiles = read_tiles(new_dir)
    old_columns = [int(path.name) for path in Path(old_dir).iterdir() if path.is_dir() and path.name.lstrip("-").isdigit()]
    if not old_columns:
        raise SystemExit(f"no old tile columns found under {old_dir}")
    old_side = max(old_columns) + 1
    old_paths = {(x, y): Path(old_dir) / str(x) / f"{y}.jpg" for x in range(old_side) for y in range(old_side)}
    old_tiles = {key: path for key, path in old_paths.items() if path.exists()}
    vectors_new = {key: tile_vector(path) for key, path in new_tiles.items()}
    vectors_old = {key: tile_vector(path) for key, path in old_tiles.items()}
    if not vectors_old:
        raise SystemExit(f"no old z=0 tiles found under {old_dir}")
    results = []
    # For a resized export the unchanged map can only be displaced by the
    # difference in tile extents. Keeping the search local avoids scanning
    # thousands of mostly non-overlapping placements.
    margin = abs(new_side - old_side)
    for dx in range(-margin, margin + 1):
        for dy in range(-margin, margin + 1):
            pairs = []
            for (ox, oy), old_vector in vectors_old.items():
                key = (ox + dx, oy + dy)
                if key in vectors_new:
                    pairs.append(np.mean((old_vector - vectors_new[key]) ** 2))
            if len(pairs) >= 100:
                results.append((float(np.mean(pairs)), dx, dy))
    return sorted(results)[:20]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("new_dir", type=Path)
    parser.add_argument("--old-tiles", type=Path, default=Path("public/tiles/0"))
    parser.add_argument("--compose", type=Path)
    args = parser.parse_args()
    side, tiles = read_tiles(args.new_dir)
    tile_size = Image.open(next(iter(tiles.values()))).size[0]
    print(f"new tiles: {side}x{side}, tile={tile_size}, pixels={side * tile_size}x{side * tile_size}")
    if args.compose:
        compose(args.new_dir, args.compose)
        print(f"composite: {args.compose.resolve()}")
    print("best overlap (MSE, new_x-old_x, new_y-old_y):")
    for mse, dx, dy in compare_new_to_old(args.new_dir, args.old_tiles):
        print(f"  {mse:.8f} {dx:+d} {dy:+d}")


if __name__ == "__main__":
    main()
