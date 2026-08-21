#!/usr/bin/env python3
"""Generate MapSource Leaflet tiles using the repository's 512px pyramid.

The source is the assembled -1 export. Zoom levels use the same powers-of-two
scaling as generate-map-tiles.ps1 and JPEG quality 88. Edge tiles are padded
with the existing map background color.
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image


Image.MAX_IMAGE_PIXELS = None
BACKGROUND = (14, 28, 29)


def generate(source: Path, destination: Path, tile_size: int, min_zoom: int, max_zoom: int, quality: int) -> None:
    image = Image.open(source).convert("RGB")
    destination.mkdir(parents=True, exist_ok=True)
    for zoom in range(min_zoom, max_zoom + 1):
        scale = 2 ** zoom
        scaled_size = (
            math.ceil(image.width * scale),
            math.ceil(image.height * scale),
        )
        scaled = image.resize(scaled_size, Image.Resampling.BICUBIC)
        columns = math.ceil(scaled.width / tile_size)
        rows = math.ceil(scaled.height / tile_size)
        print(f"Generating zoom {zoom} ({columns} x {rows} tiles)")
        for x in range(columns):
            column = destination / str(zoom) / str(x)
            column.mkdir(parents=True, exist_ok=True)
            for y in range(rows):
                tile = Image.new("RGB", (tile_size, tile_size), BACKGROUND)
                crop = scaled.crop((
                    x * tile_size,
                    y * tile_size,
                    min((x + 1) * tile_size, scaled.width),
                    min((y + 1) * tile_size, scaled.height),
                ))
                tile.paste(crop, (0, 0))
                tile.save(column / f"{y}.jpg", format="JPEG", quality=quality)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--tile-size", type=int, default=512)
    parser.add_argument("--min-zoom", type=int, default=-6)
    parser.add_argument("--max-zoom", type=int, default=0)
    parser.add_argument("--quality", type=int, default=88)
    args = parser.parse_args()
    generate(args.source, args.destination, args.tile_size, args.min_zoom, args.max_zoom, args.quality)


if __name__ == "__main__":
    main()
