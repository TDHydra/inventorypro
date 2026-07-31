#!/usr/bin/env python3
"""Move an item to Rejected, recording why. Closes any linked issue as not-planned."""
from __future__ import annotations

import argparse
import sys

from _board import (BoardError, cli, find_item, get_item, gql, load_config,
                    patch_cached_status, resolve_status, run_gh, set_status)

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
    item = find_item(cfg, args.selector, runner=runner)
    content = item.get("content") or {}
    number = content.get("number")
    note = f"\n\n---\n**Rejected:** {args.reason}"

    if number:
        run_gh(["issue", "comment", str(number), "--repo", cfg["repo"],
                "--body", f"**Rejected:** {args.reason}"], runner=runner)
        # The comment is now permanently posted. If closing the issue fails from
        # here, the user must be told the comment already landed - otherwise
        # they're left with a still-open issue carrying a rejection comment and no
        # clue why.
        try:
            run_gh(["issue", "close", str(number), "--repo", cfg["repo"],
                    "--reason", "not planned"], runner=runner)
        except BoardError as e:
            raise BoardError(
                f"the rejection comment was already posted to issue #{number}, but "
                f"closing it failed: {e}\nIssue #{number} remains OPEN and the "
                f"board item was not moved to Rejected."
            ) from e
        ref = f"#{number} closed (not planned)"
    else:
        draft_id = content.get("id")
        if not draft_id:
            raise BoardError(
                f"{item.get('title') or '(untitled)'} ({item['id']}) has malformed "
                f"draft content (missing id) - cannot record the rejection reason."
            )
        # Re-read the live draft body first: the resolved item may be a cached
        # copy, and rewriting a stale body would clobber edits made elsewhere.
        live = get_item(cfg, item["id"], runner=runner)
        live_content = (live or {}).get("content") or {}
        if live_content.get("id") == draft_id and live_content.get("body") is not None:
            content = live_content
        body = (content.get("body") or "") + note
        gql(_UPDATE_DRAFT, {"d": draft_id, "b": body}, runner=runner)
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

    if runner is None:  # injected runner = test double; don't touch the real cache
        patch_cached_status(cfg, item["id"], canonical)
    print(f"{item['title']}\n  → {canonical}  [{ref}]\n  reason: {args.reason}")
    return 0


if __name__ == "__main__":
    cli(main)
