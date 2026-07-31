#!/usr/bin/env python3
"""List InventoryPro board items, optionally filtered by status or area."""
from __future__ import annotations

import argparse
import json
import sys

from _board import BoardError, cli, fetch_items, load_config


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--status", help="filter by column, e.g. 'In progress'")
    ap.add_argument("--area", help="filter by Area field, e.g. 'Fixes'")
    ap.add_argument("--json", action="store_true", help="emit raw json")
    ap.add_argument("--refresh", action="store_true",
                    help="bypass the item-list cache and fetch live")
    args = ap.parse_args()

    cfg = load_config()
    items = fetch_items(cfg, refresh=args.refresh)

    if args.status:
        items = [i for i in items if (i.get("status") or "").lower() == args.status.lower()]
    if args.area:
        items = [i for i in items if (i.get("area") or "").lower() == args.area.lower()]

    if args.json:
        print(json.dumps(items, indent=1))
        return 0

    if not items:
        print("no matching items")
        return 0

    for item in sorted(items, key=lambda i: (i.get("status") or "", i.get("title") or "")):
        content = item.get("content") or {}
        ref = f"#{content['number']}" if content.get("number") else "draft"
        print(f"[{item.get('status') or '—':12}] {ref:>6}  {item.get('title')}")
    print(f"\n{len(items)} item(s)")
    return 0


if __name__ == "__main__":
    cli(main)
