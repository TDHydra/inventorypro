#!/usr/bin/env python3
"""Move an item to Rejected, recording why. Closes any linked issue as not-planned."""
from __future__ import annotations

import argparse
import sys

from _board import (BoardError, cli, fetch_items, gql, load_config, resolve_status,
                    run_gh, select_item, set_status)

_UPDATE_DRAFT = """
mutation($d:ID!,$b:String!){
  updateProjectV2DraftIssue(input:{draftIssueId:$d,body:$b}){ draftIssue{ id } }
}"""


def main(runner=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("selector", help="item id, issue number, or title substring")
    ap.add_argument("--reason", required=True, help="why this is being rejected")
    args = ap.parse_args()

    cfg = load_config()
    canonical, option_id = resolve_status(cfg, "Rejected")
    item = select_item(fetch_items(cfg, runner=runner), args.selector)
    content = item.get("content") or {}
    number = content.get("number")
    note = f"\n\n---\n**Rejected:** {args.reason}"

    if number:
        run_gh(["issue", "comment", str(number), "--repo", cfg["repo"],
                "--body", f"**Rejected:** {args.reason}"], runner=runner)
        run_gh(["issue", "close", str(number), "--repo", cfg["repo"],
                "--reason", "not planned"], runner=runner)
        ref = f"#{number} closed (not planned)"
    else:
        body = (content.get("body") or "") + note
        gql(_UPDATE_DRAFT, {"d": content["id"], "b": body}, runner=runner)
        ref = "draft body annotated"

    # As in gh_done.py: the issue (if any) is now permanently closed, or the
    # draft body has already been annotated. If moving the item to Rejected
    # fails from here, the user must be told what already happened so they
    # aren't left guessing why a closed issue (or annotated draft) is sitting
    # outside the Rejected column.
    try:
        set_status(cfg, item["id"], option_id, runner=runner)
    except BoardError as e:
        if number:
            raise BoardError(
                f"issue #{number} was already closed (not planned), but moving the "
                f"board item to Rejected failed: {e}\nIssue #{number} is CLOSED "
                f"while the board item is still in {item.get('status') or '—'!r} — "
                f"move it to Rejected manually."
            ) from e
        raise BoardError(
            f"the draft body was already annotated with the rejection reason, but "
            f"moving the item to Rejected failed: {e}"
        ) from e

    print(f"{item['title']}\n  → {canonical}  [{ref}]\n  reason: {args.reason}")
    return 0


if __name__ == "__main__":
    cli(main)
