"""Shared GitHub Project board access for the board skill's verb scripts.

Imported by sibling scripts via `from _board import ...`.
Knows no InventoryPro identifiers; everything comes from references/board.md.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time

_REF = os.path.join(os.path.dirname(__file__), "..", "references", "board.md")

# The full item-list pagination is expensive against the GraphQL point budget
# (it once exhausted the hourly limit mid-session), so real calls are served
# from an on-disk cache when it is younger than this.
CACHE_TTL_SECONDS = int(os.environ.get("BOARD_CACHE_TTL", str(90 * 60)))

# Below this many remaining GraphQL points, prefer a stale cache over a live
# full fetch (the quota is shared across every concurrent agent on the account).
QUOTA_FLOOR = int(os.environ.get("BOARD_QUOTA_FLOOR", "100"))


class BoardError(Exception):
    """Any failure worth showing the user verbatim."""


def load_config(path: str | None = None) -> dict:
    """Parse the first fenced ```json block out of references/board.md."""
    path = path or _REF
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        raise BoardError(f"cannot read board reference {path}: {e}") from e
    m = re.search(r"```json\n(.*?)\n```", text, re.S)
    if not m:
        raise BoardError(f"no ```json block in {path}")
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError as e:
        raise BoardError(f"bad json in {path}: {e}") from e


def run_gh(args: list[str], runner=None) -> str:
    """Run a gh command, returning stdout. Raises BoardError on failure."""
    runner = runner or subprocess.run
    try:
        proc = runner(["gh", *args], capture_output=True, text=True)
    except FileNotFoundError as e:
        raise BoardError(
            "gh is not installed or not on PATH. "
            "Install the GitHub CLI (https://cli.github.com) and try again."
        ) from e
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        if "project" in err and "scope" in err:
            raise BoardError(
                f"gh is missing the 'project' scope.\n"
                f"Run: gh auth refresh -s project,read:project\n\n{err}"
            )
        raise BoardError(f"gh {' '.join(args[:2])} failed: {err}")
    return proc.stdout


def gql(query: str, variables: dict, runner=None) -> dict:
    """Run a GraphQL query. Always -f: -F coerces numeric strings to Int."""
    args = ["api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        args += ["-f", f"{key}={value}"]
    out = run_gh(args, runner=runner)
    payload = json.loads(out)
    if "errors" in payload:
        msgs = "; ".join(e.get("message") or str(e) for e in payload["errors"])
        raise BoardError(f"graphql: {msgs}")
    return payload["data"]


def resolve_status(cfg: dict, name: str) -> tuple[str, str]:
    """Map a user-typed column name to (canonical_name, option_id)."""
    options = cfg["status_options"]
    for canonical, option_id in options.items():
        if canonical.lower() == name.strip().lower():
            return canonical, option_id
    valid = " | ".join(options)
    raise BoardError(f"unknown column {name!r}. Valid columns: {valid}")


def _cache_path(cfg: dict) -> str:
    root = os.environ.get("BOARD_CACHE_DIR") or os.path.join(
        os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"),
        "board-skill")
    return os.path.join(root, f"{cfg['project_id']}.json")


def _read_cache(cfg: dict) -> tuple[list | None, float]:
    """(items, age_seconds), or (None, 0.0) if absent or unreadable."""
    try:
        with open(_cache_path(cfg), encoding="utf-8") as f:
            payload = json.load(f)
        return payload["items"], time.time() - payload["fetched_at"]
    except (OSError, ValueError, KeyError, TypeError):
        return None, 0.0


def _write_cache(cfg: dict, items: list, fetched_at: float | None = None) -> None:
    """Best-effort atomic write; a failed cache write must never fail the command."""
    path = _cache_path(cfg)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        payload = {
            "fetched_at": time.time() if fetched_at is None else fetched_at,
            "items": items,
        }
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp, path)
    except OSError:
        pass


def invalidate_cache(cfg: dict) -> None:
    """Drop the cached item list (e.g. after adding an item the cache can't know about)."""
    try:
        os.remove(_cache_path(cfg))
    except OSError:
        pass


def patch_cached_status(cfg: dict, item_id: str, status_name: str) -> None:
    """Reflect a status change in the cache without spending API points.
    Preserves the original fetch time — the rest of the data is still that old."""
    try:
        with open(_cache_path(cfg), encoding="utf-8") as f:
            payload = json.load(f)
        for item in payload["items"]:
            if item.get("id") == item_id:
                item["status"] = status_name
        _write_cache(cfg, payload["items"], fetched_at=payload["fetched_at"])
    except (OSError, ValueError, KeyError, TypeError):
        pass


# GitHub prices GraphQL by CONNECTIONS requested (first:N multiplied down the
# tree, /100) — scalar fields are free. gh's own `project item-list` nests
# fieldValues(first:100) under items(first:100) (~100 points/page); these
# queries use single-node fieldValueByName lookups instead (~1 point/page).
_ITEM_FIELDS = """
        title: fieldValueByName(name:"Title"){ ... on ProjectV2ItemFieldTextValue { text } }
        status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
        priority: fieldValueByName(name:"Priority"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
        area: fieldValueByName(name:"Area"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }"""

_ITEM_CONTENT = """
        content{
          __typename
          ... on Issue { number title body url repository { nameWithOwner } }
          ... on DraftIssue { id title body }
        }"""

_ITEMS_QUERY = """
query BoardItems($project:ID!,$cursor:String){
  node(id:$project){ ... on ProjectV2 {
    items(first:100, after:$cursor){
      pageInfo{ hasNextPage endCursor }
      nodes{
        id""" + _ITEM_FIELDS + _ITEM_CONTENT + """
      }
    }
  } }
}"""

_NODE_QUERY = """
query ItemNode($item:ID!){
  node(id:$item){ ... on ProjectV2Item {
    id""" + _ITEM_FIELDS + _ITEM_CONTENT + """
  } }
}"""

# issue number is inlined (validated .isdigit() first): gql() sends every
# variable with -f, which is string-typed, so an $n:Int! variable can never be
# satisfied — the inverse of board.md trap 1.
_ISSUE_QUERY = """
query IssueItem($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    issue(number:%d){
      number title body url
      projectItems(first:10){
        nodes{
          id
          project{ id }""" + _ITEM_FIELDS + """
        }
      }
    }
  }
}"""


def _normalize_node(node: dict) -> dict:
    """Reshape a lean-query item node into the dict shape `gh project item-list`
    used to emit, which every consumer of fetch_items still expects."""
    content = node.get("content")
    typename = (content or {}).get("__typename")
    if content is None:
        norm_content = None
    else:
        norm_content = {"type": typename, "title": content.get("title"),
                        "body": content.get("body")}
        if typename == "Issue":
            norm_content["number"] = content.get("number")
            norm_content["url"] = content.get("url")
            repo = (content.get("repository") or {}).get("nameWithOwner")
            if repo:
                norm_content["repository"] = repo
        elif typename == "DraftIssue":
            norm_content["id"] = content.get("id")
    return {
        "id": node["id"],
        "title": (node.get("title") or {}).get("text") or (content or {}).get("title"),
        "status": (node.get("status") or {}).get("name"),
        "priority": (node.get("priority") or {}).get("name"),
        "area": (node.get("area") or {}).get("name"),
        "content": norm_content,
    }


def _fetch_all_pages(cfg: dict, runner=None) -> list[dict]:
    items, cursor = [], None
    while True:
        variables = {"project": cfg["project_id"]}
        if cursor:
            variables["cursor"] = cursor
        data = gql(_ITEMS_QUERY, variables, runner=runner)
        conn = (data.get("node") or {}).get("items") or {}
        items += [_normalize_node(n) for n in conn.get("nodes") or []]
        page = conn.get("pageInfo") or {}
        if not page.get("hasNextPage"):
            return items
        cursor = page["endCursor"]


def _graphql_points_remaining(runner=None) -> int | None:
    """REST — free against both quotas. None (fail open) if undeterminable."""
    try:
        out = run_gh(["api", "rate_limit", "--jq", ".resources.graphql.remaining"],
                     runner=runner)
        return int(out.strip())
    except (BoardError, ValueError):
        return None


def fetch_items(cfg: dict, runner=None, refresh=False) -> list[dict]:
    """Every item on the board, via the lean paginated query.

    Cached on disk for CACHE_TTL_SECONDS — but only when no runner is injected:
    an injected runner is a test double, and fakes must never read or write the
    real cache. When GraphQL points run low a stale cache beats a live fetch,
    and if the live fetch fails any cached copy, however stale, beats an error.
    """
    use_cache = runner is None
    if use_cache and not refresh:
        items, age = _read_cache(cfg)
        if items is not None and age < CACHE_TTL_SECONDS:
            print(f"note: board list from cache ({int(age // 60)}m old; "
                  f"gh_list.py --refresh for live)", file=sys.stderr)
            return items
        remaining = _graphql_points_remaining()
        if remaining is not None and remaining < QUOTA_FLOOR and items is not None:
            print(f"warning: only {remaining} GraphQL points left; using stale "
                  f"cache ({int(age // 60)}m old) instead of a live fetch",
                  file=sys.stderr)
            return items
    try:
        items = _fetch_all_pages(cfg, runner=runner)
    except BoardError:
        if use_cache:
            items, age = _read_cache(cfg)
            if items is not None:
                print(f"warning: live fetch failed; using stale cache "
                      f"({int(age // 60)}m old)", file=sys.stderr)
                return items
        raise
    if use_cache:
        _write_cache(cfg, items)
    return items


def get_item(cfg: dict, item_id: str, runner=None) -> dict | None:
    """One item by its PVTI_ node id (~1 point). None if it isn't a project item."""
    data = gql(_NODE_QUERY, {"item": item_id}, runner=runner)
    node = data.get("node")
    if not node or "id" not in node:
        return None
    return _normalize_node(node)


def _lookup_issue_item(cfg: dict, number: int, runner=None) -> dict | None:
    """Resolve issue #number to its item on THIS project (~1 point)."""
    try:
        data = gql(_ISSUE_QUERY % number,
                   {"owner": cfg["owner"], "name": cfg["repo"].split("/")[-1]},
                   runner=runner)
    except BoardError as e:
        if "could not resolve" in str(e).lower():
            return None
        raise
    issue = (data.get("repository") or {}).get("issue")
    if not issue:
        return None
    for pnode in ((issue.get("projectItems") or {}).get("nodes") or []):
        if (pnode.get("project") or {}).get("id") != cfg["project_id"]:
            continue
        return {
            "id": pnode["id"],
            "title": (pnode.get("title") or {}).get("text") or issue.get("title"),
            "status": (pnode.get("status") or {}).get("name"),
            "priority": (pnode.get("priority") or {}).get("name"),
            "area": (pnode.get("area") or {}).get("name"),
            "content": {"type": "Issue", "number": issue.get("number"),
                        "title": issue.get("title"), "body": issue.get("body"),
                        "url": issue.get("url"), "repository": cfg["repo"]},
        }
    return None


def find_item(cfg: dict, selector: str, runner=None) -> dict:
    """Resolve one item at the lowest quota cost: fresh cache (free), then a
    one-point targeted lookup for issue-number / item-id selectors, then the
    full (cached) fetch for title substrings."""
    sel = selector.strip()
    if runner is None:
        items, age = _read_cache(cfg)
        if items is not None and age < CACHE_TTL_SECONDS:
            try:
                return select_item(items, sel)
            except BoardError:
                pass  # not in (or ambiguous in) the cache — resolve live
    number = sel.lstrip("#")
    if number.isdigit():
        item = _lookup_issue_item(cfg, int(number), runner=runner)
        if item is None:
            raise BoardError(f"no board item for issue #{number}")
        return item
    if sel.startswith("PVTI_"):
        item = get_item(cfg, sel, runner=runner)
        if item is None:
            raise BoardError(f"no board item {sel!r}")
        return item
    return select_item(fetch_items(cfg, runner=runner), sel)


def select_item(items: list[dict], selector: str) -> dict:
    """Find one item by item id, issue number, or unique title substring."""
    sel = selector.strip()

    for item in items:
        if item["id"] == sel:
            return item

    number = sel.lstrip("#")
    if number.isdigit():
        hits = [i for i in items if (i.get("content") or {}).get("number") == int(number)]
        if len(hits) == 1:
            return hits[0]
        if not hits:
            raise BoardError(f"no board item for issue #{number}")
        listing = "\n".join(f"  - {i.get('title') or '(untitled)'} ({i['id']})" for i in hits)
        raise BoardError(f"issue #{number} matches {len(hits)} items:\n{listing}")

    needle = sel.lower()
    hits = [i for i in items if needle in (i.get("title") or "").lower()]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        raise BoardError(f"no board item matching {selector!r}")
    listing = "\n".join(f"  - {i.get('title') or '(untitled)'} ({i['id']})" for i in hits)
    raise BoardError(f"{selector!r} matches {len(hits)} items:\n{listing}")


_SET_FIELD = """
mutation($project:ID!,$item:ID!,$field:ID!,$opt:String!){
  updateProjectV2ItemFieldValue(input:{
    projectId:$project, itemId:$item, fieldId:$field,
    value:{singleSelectOptionId:$opt}
  }){ projectV2Item { id } }
}"""


def set_status(cfg: dict, item_id: str, option_id: str, runner=None) -> None:
    """Move one item to one column. Note: -f only, never -F."""
    gql(_SET_FIELD, {
        "project": cfg["project_id"],
        "item": item_id,
        "field": cfg["status_field_id"],
        "opt": option_id,
    }, runner=runner)


def cli(main_fn) -> "NoReturn":
    """Shared entry point for every verb script. Exits nonzero with a readable message."""
    import sys

    try:
        sys.exit(main_fn())
    except BoardError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
