#!/usr/bin/env python3
"""Convert the imported marker snapshot into the local editable map format."""

from __future__ import annotations

import argparse
import json
import re
import os
import tempfile
from collections import Counter
from pathlib import Path


CATEGORY_SLUGS = {
    "谕石": "oracle-stone",
    "21的赠礼": "gift-21",
    "打卡": "checkin",
    "支线任务": "sidequest",
    "异象委托": "anomaly",
    "街头正义": "street-justice",
    "手办": "figurine",
    "家具": "furniture",
    "魔术师的馈赠": "magician-gift",
    "避影的包裹": "package",
    "杂物": "sundries",
    "电话亭": "phonebooth",
    "维特海默塔": "tower",
    "纸鸢战队": "paper-kite",
    "羽偶": "feather-doll",
    "妖刀": "demon-blade",
    "无名伞": "nameless-umbrella",
    "瓦楞城堡": "cardboard-castle",
    "扫晴娘": "sunshine-doll",
    "伪电话亭": "fake-phonebooth",
    "唱片附电灵": "record-spirit",
    "售货附电灵": "vending-spirit",
    "分解者": "dismantler",
    "凭依种": "possessed",
    "伤心英熊": "sad-bear",
    "风洞种": "wind-cave",
    "雨人": "rain-man",
    "长明灯": "eternal-lamp",
    "迷失种": "lost",
    "诺诺斯": "nonos",
    "诡面筝": "mask-kite",
    "流梦种": "dream",
    "洄天鱼幡": "fish-banner",
    "波普": "pop",
    "棉绒绒": "cotton",
    "拖车艄": "towboat",
    "抱抱藤": "hug-vine",
}

MAP_CONFIG = {
    "width": 22528,
    "height": 22528,
    "tileSize": 512,
    "mapLocatorSourceWidth": 11264,
    "mapLocatorSourceHeight": 11264,
    "coordinateSystem": "game-affine-v1",
}

CALIBRATION = json.loads(
    (Path(__file__).parent.parent / "src/data/navi-coordinate-calibration.json").read_text(encoding="utf-8")
)


def normalized_coordinates(location: dict) -> dict:
    if isinstance(location.get("x"), (int, float)) and isinstance(location.get("y"), (int, float)):
        return {"x": location["x"], "y": location["y"]}
    pixel_x = CALIBRATION["sourceWidth"] / 2 + float(location["lng"]) * 22
    pixel_y = CALIBRATION["sourceHeight"] / 2 - float(location["lat"]) * 22
    bounds = CALIBRATION["worldBounds"]
    return {
        "x": round((pixel_x / CALIBRATION["sourceWidth"] - 0.5) * bounds["size"]["x"] + bounds["center"]["x"], 3),
        "y": round((pixel_y / CALIBRATION["sourceHeight"] - 0.5) * bounds["size"]["y"] + bounds["center"]["y"], 3),
    }


def extract_export(source: str, name: str) -> list[dict]:
    match = re.search(
        rf"export const {re.escape(name)} = (\[.*?\])\s*(?=export const|\Z)",
        source,
        re.DOTALL,
    )
    if not match:
        raise ValueError(f"Could not find export: {name}")
    return json.loads(match.group(1))


def clean_snapshot(source_path: Path) -> dict:
    source = source_path.read_text(encoding="utf-8")
    imported_categories = extract_export(source, "importedCategories")
    imported_locations = extract_export(source, "importedLocations")

    categories = []
    category_id_by_imported_id: dict[str, str] = {}
    used_slugs: Counter[str] = Counter()

    for index, category in enumerate(imported_categories, start=1):
        label = category["label"]
        base_slug = CATEGORY_SLUGS.get(label, f"category-{index:03d}")
        used_slugs[base_slug] += 1
        slug = base_slug if used_slugs[base_slug] == 1 else f"{base_slug}-{used_slugs[base_slug]}"
        category_id_by_imported_id[category["id"]] = slug
        categories.append(
            {
                "id": slug,
                "group": category["groupLabel"],
                "label": label,
                "icon": category["icon"],
                "color": category["color"],
                "isDefault": bool(category.get("isDefault")),
                "isHidden": bool(category.get("isHidden")),
            }
        )

    location_sequence: Counter[str] = Counter()
    locations = []
    for location in imported_locations:
        category_id = category_id_by_imported_id[location["category"]]
        location_sequence[category_id] += 1
        local_id = f"{category_id}-{location_sequence[category_id]:03d}"
        locations.append(
            {
                "id": local_id,
                "name": location["name"],
                "types": [category_id],
                "district": location.get("district", "全地图"),
                **normalized_coordinates(location),
                "description": location.get("description", ""),
                "tags": list(dict.fromkeys(location.get("tags", []))),
                "images": [],
            }
        )

    return {
        "version": 2,
        "map": MAP_CONFIG,
        "categories": categories,
        "locations": locations,
        "routes": [],
    }


def clean_local_data(source_path: Path) -> dict:
    source = json.loads(source_path.read_text(encoding="utf-8"))
    if "locationFiles" in source:
        source["locations"] = []
        for filename in source["locationFiles"]:
            if not re.fullmatch(r"locations/[a-z0-9][a-z0-9_-]{0,79}\.json", filename):
                raise ValueError(f"Invalid location filename: {filename}")
            source["locations"].extend(json.loads((source_path.parent / filename).read_text(encoding="utf-8")))
    categories = [
        {
            "id": category["id"],
            "group": category["group"],
            "label": category["label"],
            "icon": category["icon"],
            **({"iconUrl": category["iconUrl"]} if "iconUrl" in category else {}),
            "color": category["color"],
            "isDefault": bool(category.get("isDefault")),
            "isHidden": bool(category.get("isHidden")),
        }
        for category in source["categories"]
    ]
    locations = [
        {
            "id": location["id"],
            "name": location["name"],
            "types": location["types"],
            "district": location.get("district", "全地图"),
            **normalized_coordinates(location),
            **({"z": location["z"]} if "z" in location else {}),
            **({"betterMapId": location["betterMapId"]} if "betterMapId" in location else {}),
            **({"gameDataId": location["gameDataId"]} if "gameDataId" in location else {}),
            **({"source": location["source"]} if "source" in location else {}),
            "description": location.get("description", ""),
            "tags": location.get("tags", []),
            "images": location.get("images", []),
        }
        for location in source["locations"]
    ]
    return {
        "version": 2,
        "map": source.get("map", MAP_CONFIG),
        "categories": categories,
        "locations": locations,
        "routes": source.get("routes", []),
        **({"locationFiles": source["locationFiles"]} if "locationFiles" in source else {}),
    }


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input",
        type=Path,
        default=Path("src/data/map-data.json"),
        help="Local JSON data or a legacy imported JavaScript snapshot to clean.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("src/data/map-data.json"),
        help="Local editable JSON file to write.",
    )
    args = parser.parse_args()

    cleaned = clean_local_data(args.input) if args.input.suffix == ".json" else clean_snapshot(args.input)
    if "locationFiles" in cleaned:
        files = {filename: [] for filename in cleaned["locationFiles"]}
        for location in cleaned["locations"]:
            category = location["types"][0]
            if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,79}", category):
                raise ValueError(f"Invalid location category: {category}")
            files.setdefault(f"locations/{category}.json", []).append(location)
        cleaned["locationFiles"] = sorted(files)
        for filename, locations in files.items():
            write_json(args.output.parent / filename, locations)
        write_json(args.output, {key: value for key, value in cleaned.items() if key != "locations"})
    else:
        write_json(args.output, cleaned)
    print(
        f"Wrote {len(cleaned['locations'])} locations and "
        f"{len(cleaned['categories'])} categories to {args.output}"
    )


if __name__ == "__main__":
    main()
