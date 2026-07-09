#!/usr/bin/env python3
"""Add an item to the board, as a real issue (default) or a draft."""
from __future__ import annotations

import argparse
import json
import sys

from _board import BoardError, cli, gql, load_config, resolve_status, run_gh, set_status

_ADD_DRAFT = """
mutation($p:ID!,$t:String!,$b:String!){
  addProjectV2DraftIssue(input:{projectId:$p,title:$t,body:$b}){ projectItem{ id } }
}"""

_ADD_ITEM = """
mutation($p:ID!,$c:ID!){
  addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } }
}"""


def main() -> int:
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

    if args.draft:
        data = gql(_ADD_DRAFT, {"p": cfg["project_id"], "t": args.title, "b": args.body})
        item_id = data["addProjectV2DraftIssue"]["projectItem"]["id"]
        ref = "draft"
    else:
        out = run_gh(["issue", "create", "--repo", cfg["repo"],
                      "--title", args.title, "--body", args.body or args.title])
        url = out.strip().splitlines()[-1]
        number = url.rstrip("/").split("/")[-1]
        node = json.loads(run_gh(["issue", "view", number, "--repo", cfg["repo"],
                                  "--json", "id"]))["id"]
        data = gql(_ADD_ITEM, {"p": cfg["project_id"], "c": node})
        item_id = data["addProjectV2ItemById"]["item"]["id"]
        ref = f"#{number}"

    set_status(cfg, item_id, option_id)
    print(f"{ref}  {args.title}\n  → {canonical}")
    return 0


if __name__ == "__main__":
    cli(main)
