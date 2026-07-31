#!/usr/bin/env python3
"""Move a board item to a column. Refuses Done and Rejected — use gh_done/gh_reject."""
from __future__ import annotations

import argparse
import sys

from _board import (BoardError, cli, find_item, load_config, patch_cached_status,
                    resolve_status, set_status)

GUARDED = {"Done": "gh_done.py", "Rejected": "gh_reject.py"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("selector", help="item id, issue number, or title substring")
    ap.add_argument("status", help="target column")
    args = ap.parse_args()

    cfg = load_config()
    canonical, option_id = resolve_status(cfg, args.status)

    if canonical in GUARDED:
        raise BoardError(
            f"{canonical!r} does more than move an item — use "
            f"{GUARDED[canonical]} so the linked issue stays consistent."
        )

    item = find_item(cfg, args.selector)
    before = item.get("status") or "—"
    set_status(cfg, item["id"], option_id)
    patch_cached_status(cfg, item["id"], canonical)
    print(f"{item['title']}\n  {before} → {canonical}")
    return 0


if __name__ == "__main__":
    cli(main)
