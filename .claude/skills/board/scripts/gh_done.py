#!/usr/bin/env python3
"""Move an item to Done and close its linked issue. Refuses to leave them inconsistent."""
from __future__ import annotations

import argparse
import sys

from _board import (BoardError, cli, find_item, load_config, patch_cached_status,
                    resolve_status, run_gh, set_status)


def main(runner=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("selector", help="item id, issue number, or title substring")
    args = ap.parse_args()

    cfg = load_config()
    canonical, option_id = resolve_status(cfg, "Done")
    item = find_item(cfg, args.selector, runner=runner)
    content = item.get("content") or {}
    number = content.get("number")

    if number:
        # Close first. If this fails we must NOT move the item.
        run_gh(["issue", "close", str(number), "--repo", cfg["repo"],
                "--reason", "completed"], runner=runner)
        ref = f"#{number} closed"
    else:
        ref = "draft (no issue to close)"

    # The issue (if any) is now permanently closed. If moving the item to Done
    # fails from here, the user must be told the issue was already closed -
    # otherwise they're left with a closed issue sitting outside Done and no
    # clue why, which is the same inconsistency this script exists to prevent.
    try:
        set_status(cfg, item["id"], option_id, runner=runner)
    except BoardError as e:
        if number:
            raise BoardError(
                f"issue #{number} was already closed, but moving the board item to "
                f"Done failed: {e}\nIssue #{number} is CLOSED while the board item "
                f"is still in {item.get('status') or '—'!r} — move it to Done "
                f"manually to avoid a closed issue sitting outside Done."
            ) from e
        raise BoardError(f"failed to move draft item to Done: {e}") from e

    if runner is None:  # injected runner = test double; don't touch the real cache
        patch_cached_status(cfg, item["id"], canonical)
    print(f"{item['title']}\n  {item.get('status') or '—'} → {canonical}  [{ref}]")
    return 0


if __name__ == "__main__":
    cli(main)
