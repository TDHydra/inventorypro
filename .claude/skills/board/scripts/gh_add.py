#!/usr/bin/env python3
"""Add an item to the board, as a real issue (default) or a draft."""
from __future__ import annotations

import argparse
import json
import sys

from _board import (BoardError, cli, gql, invalidate_cache, load_config,
                    resolve_status, run_gh, set_status)

_ADD_DRAFT = """
mutation($p:ID!,$t:String!,$b:String!){
  addProjectV2DraftIssue(input:{projectId:$p,title:$t,body:$b}){ projectItem{ id } }
}"""

_ADD_ITEM = """
mutation($p:ID!,$c:ID!){
  addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } }
}"""


def main(runner=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("title")
    ap.add_argument("--body", default="")
    kind = ap.add_mutually_exclusive_group()
    kind.add_argument("--draft", action="store_true", help="draft item (history only)")
    kind.add_argument("--issue", action="store_true", help="real issue (default)")
    ap.add_argument("--status", default="Backlog")
    args = ap.parse_args()

    cfg = load_config()
    canonical, option_id = resolve_status(cfg, args.status)

    # Once set, a real GitHub issue exists and is permanent (can be closed, never
    # deleted). Every failure from this point on must name it, so the user is never
    # left with an orphaned issue and a generic error message.
    issue_ref = None

    if args.draft:
        data = gql(_ADD_DRAFT, {"p": cfg["project_id"], "t": args.title, "b": args.body},
                    runner=runner)
        item_id = data["addProjectV2DraftIssue"]["projectItem"]["id"]
        ref = "draft"
    else:
        out = run_gh(["issue", "create", "--repo", cfg["repo"],
                      "--title", args.title, "--body", args.body or args.title],
                     runner=runner)
        url = out.strip().splitlines()[-1]
        number = url.rstrip("/").split("/")[-1]
        if not number.isdigit():
            raise BoardError(
                f"gh issue create returned an unparseable URL ({url!r}); could not "
                f"extract an issue number from it. The issue may still have been "
                f"created — raw gh issue create output:\n{out}"
            )
        issue_ref = f"#{number}"
        issue_url = url

        try:
            node = json.loads(run_gh(["issue", "view", number, "--repo", cfg["repo"],
                                      "--json", "id"], runner=runner))["id"]
            data = gql(_ADD_ITEM, {"p": cfg["project_id"], "c": node}, runner=runner)
            item_id = data["addProjectV2ItemById"]["item"]["id"]
        except BoardError as e:
            raise BoardError(
                f"created issue {issue_ref} ({issue_url}) but failed to add it to the "
                f"board: {e}\nIssue {issue_ref} exists on GitHub but is NOT on the "
                f"board."
            ) from e
        ref = issue_ref

    try:
        set_status(cfg, item_id, option_id, runner=runner)
    except BoardError as e:
        if issue_ref:
            raise BoardError(
                f"created issue {issue_ref} and added it to the board, but failed to "
                f"set its status: {e}\nIssue {issue_ref} is on the board with NO "
                f"status set."
            ) from e
        raise BoardError(f"created draft item but failed to set its status: {e}") from e

    if runner is None:  # injected runner = test double; don't touch the real cache
        invalidate_cache(cfg)
    print(f"{ref}  {args.title}\n  → {canonical}")
    return 0


if __name__ == "__main__":
    cli(main)
