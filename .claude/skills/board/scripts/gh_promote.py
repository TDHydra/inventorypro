#!/usr/bin/env python3
"""Convert a draft board item into a real GitHub issue. IRREVERSIBLE."""
from __future__ import annotations

import argparse

from _board import BoardError, cli, find_item, gql, invalidate_cache, load_config

_CONVERT = """
mutation($item:ID!,$repo:ID!){
  convertProjectV2DraftIssueItemToIssue(input:{itemId:$item,repositoryId:$repo}){
    item{ id content{ ... on Issue { number url } } }
  }
}"""


def main(runner=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("selector", help="item id, or title substring")
    ap.add_argument("--yes", action="store_true", help="required: this cannot be undone")
    args = ap.parse_args()

    cfg = load_config()
    item = find_item(cfg, args.selector, runner=runner)
    content = item.get("content") or {}

    if content.get("type") != "DraftIssue":
        raise BoardError(
            f"{item['title']!r} is already issue #{content.get('number')}; nothing to promote."
        )

    if not args.yes:
        print(f"Would convert draft → real issue in {cfg['repo']}:\n  {item['title']}\n"
              f"\nThis cannot be undone. Re-run with --yes.")
        return 1

    data = gql(_CONVERT, {"item": item["id"], "repo": cfg["repo_id"]}, runner=runner)
    issue = (data["convertProjectV2DraftIssueItemToIssue"]["item"].get("content") or {})
    number, url = issue.get("number"), issue.get("url")
    if not number:
        # The conversion may still have happened; say so rather than implying it didn't.
        raise BoardError(
            f"converted {item['title']!r} but GitHub returned no issue number. "
            f"Check the board and `gh issue list` before retrying — a retry could "
            f"create a second issue."
        )

    if runner is None:  # injected runner = test double; don't touch the real cache
        invalidate_cache(cfg)
    print(f"{item['title']}\n  → #{number}  {url}")
    return 0


if __name__ == "__main__":
    cli(main)
