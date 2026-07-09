# GitHub Board Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude skill that makes GitHub Project 2 the operable source of truth for the InventoryPro backlog, with writes gated by the cost of being wrong.

**Architecture:** A project skill at `~/inventorypro/.claude/skills/board/`. `references/board.md` holds every InventoryPro-specific identifier inside a fenced JSON block; `scripts/_board.py` parses it and owns all GitHub access. Six verb scripts sit on top, each doing one thing. A conditional `Stop` hook reminds Claude to reconcile the board when a commit landed during the turn.

**Tech Stack:** Python 3.12 (stdlib only — `unittest`, `subprocess`, `json`, `re`, `argparse`), `gh` CLI 2.62.0, GitHub GraphQL API.

## Global Constraints

- **Python stdlib only.** `pytest` is not installed. Tests use `unittest`. Do not add dependencies.
- **Never use `gh api graphql -F`.** It coerces numeric-looking strings (option IDs like `"98236657"`) to `Int`, failing `String!` variables. Always `-f`.
- **Never call `updateProjectV2Field` without passing every existing option's `id`.** Omitting IDs recreates options and silently clears that field on every board item.
- **Scripts hardcode no identifiers.** Every ID comes from `references/board.md`. Only that file knows this is InventoryPro.
- **Every script exits nonzero with a readable message on failure.** No silent `continue`.
- Repo: `TDHydra/inventorypro`, node id `R_kgDOTHELWA`. Project 2, owner `TDHydra`, id `PVT_kwHODJIRY84Bc40q`.
- Requires `gh` token scope `project`. If absent, scripts must say so and tell the user to run `gh auth refresh -s project,read:project`.

## File Structure

| File | Responsibility |
|---|---|
| `.claude/skills/board/SKILL.md` | Trigger description; which verb for which intent; the write-gating rules. |
| `.claude/skills/board/references/board.md` | The only InventoryPro-specific file. IDs in a fenced JSON block; prose explains the columns. |
| `.claude/skills/board/scripts/_board.py` | Config load, `gh` invocation, GraphQL, status/area resolution, item selection. No CLI. |
| `.claude/skills/board/scripts/gh_list.py` | Read and filter the board. |
| `.claude/skills/board/scripts/gh_move.py` | Move an item to any column. |
| `.claude/skills/board/scripts/gh_add.py` | Create an item, as draft or real issue. |
| `.claude/skills/board/scripts/gh_done.py` | Move to `Done` **and** close the linked issue. |
| `.claude/skills/board/scripts/gh_reject.py` | Move to `Rejected` **and** record the reason. |
| `.claude/skills/board/scripts/gh_promote.py` | Draft → real issue. Irreversible. |
| `.claude/skills/board/tests/test_board.py` | `unittest` over the pure logic in `_board.py`, with a fake `gh` runner. |
| `.claude/hooks/board_reminder.sh` | `Stop` hook: fire only when a commit landed this turn. |
| `.claude/settings.json` | Registers the hook. Does not exist yet. |

Tests cover `_board.py` only. The verb scripts are thin argparse wrappers whose real behavior is network I/O; they are verified by exercising them against the live board, which is what the Verification steps do. Testing them with mocks would prove only that the mocks match my guesses about GitHub's responses.

---

### Task 1: `references/board.md` and `_board.py` config loading

**Files:**
- Create: `~/inventorypro/.claude/skills/board/references/board.md`
- Create: `~/inventorypro/.claude/skills/board/scripts/_board.py`
- Test: `~/inventorypro/.claude/skills/board/tests/test_board.py`

**Interfaces:**
- Produces: `load_config(path: str | None = None) -> dict` — parses the first fenced ```json block from `references/board.md`. `BoardError(Exception)`.

- [ ] **Step 1: Write `references/board.md`**

````markdown
# InventoryPro board facts

The live backlog is GitHub Project 2: https://github.com/users/TDHydra/projects/2

`docs/BACKLOG-archive-2026-07-09.md` is the frozen predecessor. Do not edit it.

## Columns

| Column | Meaning |
|---|---|
| `Backlog` | Known work, not scheduled. |
| `Ready` | Scheduled; next up. |
| `In progress` | Actively being worked. |
| `In review` | Code written, awaiting review or on-device verification. |
| `Done` | Finished **and** verified. If issue-backed, the issue is closed. |
| `Rejected` | Decided against. Body records why. |

Items in `Backlog`/`Ready`/`In progress`/`In review` are real GitHub issues, so commits and PRs
can cite them. Items in `Done`/`Rejected` are draft issues — archaeology, nothing links to them.

## Identifiers

```json
{
  "owner": "TDHydra",
  "project_number": 2,
  "project_id": "PVT_kwHODJIRY84Bc40q",
  "repo": "TDHydra/inventorypro",
  "repo_id": "R_kgDOTHELWA",
  "status_field_id": "PVTSSF_lAHODJIRY84Bc40qzhXeW4E",
  "status_options": {
    "Backlog": "f75ad846",
    "Ready": "e18bf179",
    "In progress": "47fc9ee4",
    "In review": "aba860b9",
    "Done": "98236657",
    "Rejected": "5da22600"
  },
  "area_field_id": "PVTSSF_lAHODJIRY84Bc40qzhXecgY",
  "rehearsal_project_id": "PVT_kwHODJIRY84Bc42n"
}
```

`rehearsal_project_id` is the unused Project 3, used to rehearse irreversible operations.

## Traps

1. `gh api graphql -F` coerces `"98236657"` to `Int` and fails `String!`. Use `-f`.
2. `updateProjectV2Field` replaces the whole single-select option list. Pass every existing
   option **with its `id`** or every item's status is silently cleared.
````

- [ ] **Step 2: Write the failing test**

Create `tests/test_board.py`:

```python
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import _board


class TestLoadConfig(unittest.TestCase):
    def test_reads_ids_from_reference_file(self):
        cfg = _board.load_config()
        self.assertEqual(cfg["owner"], "TDHydra")
        self.assertEqual(cfg["project_number"], 2)
        self.assertEqual(cfg["repo_id"], "R_kgDOTHELWA")
        self.assertEqual(cfg["status_options"]["Done"], "98236657")

    def test_missing_file_raises_boarderror(self):
        with self.assertRaises(_board.BoardError):
            _board.load_config("/nonexistent/board.md")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/inventorypro/.claude/skills/board && python3 -m unittest tests.test_board -v`
Expected: FAIL — `ModuleNotFoundError: No module named '_board'`

- [ ] **Step 4: Write minimal `_board.py`**

```python
"""Shared GitHub Project board access for the board skill's verb scripts.

Imported by sibling scripts via `from _board import ...`.
Knows no InventoryPro identifiers; everything comes from references/board.md.
"""
from __future__ import annotations

import json
import os
import re

_REF = os.path.join(os.path.dirname(__file__), "..", "references", "board.md")


class BoardError(Exception):
    """Any failure worth showing the user verbatim."""


def load_config(path: str | None = None) -> dict:
    """Parse the first fenced ```json block out of references/board.md."""
    path = path or _REF
    try:
        text = open(path, encoding="utf-8").read()
    except OSError as e:
        raise BoardError(f"cannot read board reference {path}: {e}") from e
    m = re.search(r"```json\n(.*?)\n```", text, re.S)
    if not m:
        raise BoardError(f"no ```json block in {path}")
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError as e:
        raise BoardError(f"bad json in {path}: {e}") from e
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/inventorypro/.claude/skills/board && python3 -m unittest tests.test_board -v`
Expected: PASS, 2 tests

- [ ] **Step 6: Commit**

```bash
cd ~/inventorypro
git add .claude/skills/board/
git commit -m "feat(board): board reference file + config loader"
```

---

### Task 2: `gh` invocation and GraphQL in `_board.py`

**Files:**
- Modify: `~/inventorypro/.claude/skills/board/scripts/_board.py`
- Test: `~/inventorypro/.claude/skills/board/tests/test_board.py`

**Interfaces:**
- Consumes: `BoardError` from Task 1.
- Produces: `run_gh(args: list[str], runner=None) -> str`; `gql(query: str, variables: dict, runner=None) -> dict`. `runner` is an injection point for tests; it defaults to `subprocess.run`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_board.py`:

```python
class FakeCompleted:
    def __init__(self, returncode=0, stdout="{}", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class TestGql(unittest.TestCase):
    def test_never_uses_dash_F(self):
        """-F coerces numeric option ids to Int and breaks String! variables."""
        seen = {}

        def runner(cmd, **kwargs):
            seen["cmd"] = cmd
            return FakeCompleted(stdout='{"data":{"ok":true}}')

        _board.gql("mutation($opt:String!){x}", {"opt": "98236657"}, runner=runner)
        self.assertNotIn("-F", seen["cmd"])
        self.assertIn("-f", seen["cmd"])
        self.assertIn("opt=98236657", seen["cmd"])

    def test_graphql_errors_raise(self):
        def runner(cmd, **kwargs):
            return FakeCompleted(stdout='{"errors":[{"message":"boom"}]}')

        with self.assertRaises(_board.BoardError) as ctx:
            _board.gql("query{x}", {}, runner=runner)
        self.assertIn("boom", str(ctx.exception))

    def test_nonzero_exit_raises_with_stderr(self):
        def runner(cmd, **kwargs):
            return FakeCompleted(returncode=1, stdout="", stderr="missing scope: project")

        with self.assertRaises(_board.BoardError) as ctx:
            _board.gql("query{x}", {}, runner=runner)
        self.assertIn("project", str(ctx.exception))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/inventorypro/.claude/skills/board && python3 -m unittest tests.test_board -v`
Expected: FAIL — `AttributeError: module '_board' has no attribute 'gql'`

- [ ] **Step 3: Implement**

Add to `_board.py`:

```python
import subprocess


def run_gh(args: list[str], runner=None) -> str:
    """Run a gh command, returning stdout. Raises BoardError on failure."""
    runner = runner or subprocess.run
    proc = runner(["gh", *args], capture_output=True, text=True)
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
        msgs = "; ".join(e.get("message", str(e)) for e in payload["errors"])
        raise BoardError(f"graphql: {msgs}")
    return payload["data"]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/inventorypro/.claude/skills/board && python3 -m unittest tests.test_board -v`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
cd ~/inventorypro
git add .claude/skills/board/
git commit -m "feat(board): gh runner + graphql wrapper that can never use -F"
```

---

### Task 3: Status resolution and item selection

**Files:**
- Modify: `~/inventorypro/.claude/skills/board/scripts/_board.py`
- Test: `~/inventorypro/.claude/skills/board/tests/test_board.py`

**Interfaces:**
- Produces:
  - `resolve_status(cfg: dict, name: str) -> tuple[str, str]` → `(canonical_name, option_id)`. Case-insensitive. Unknown name raises `BoardError` listing valid columns.
  - `fetch_items(cfg: dict, runner=None) -> list[dict]` → each item as `gh project item-list --format json` returns it.
  - `select_item(items: list[dict], selector: str) -> dict` → match by exact item id (`PVTI_…`), else issue number (`42` or `#42`), else unique case-insensitive title substring. Zero matches or ambiguity raises `BoardError`.

Item shape from `gh project item-list --format json`:
```json
{"id": "PVTI_…", "title": "…", "status": "Backlog", "area": "Fixes",
 "content": {"type": "Issue", "number": 42, "id": "I_…", "body": "…"}}
```
`content.type` is `"DraftIssue"` for drafts, which have no `number`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_board.py`:

```python
CFG = {
    "owner": "TDHydra",
    "project_number": 2,
    "status_options": {
        "Backlog": "f75ad846",
        "In progress": "47fc9ee4",
        "Done": "98236657",
        "Rejected": "5da22600",
    },
}

ITEMS = [
    {"id": "PVTI_aaa", "title": "Pin MinIO to the RUNNING version",
     "status": "Ready", "content": {"type": "DraftIssue"}},
    {"id": "PVTI_bbb", "title": "Componentization Wave 2",
     "status": "Backlog", "content": {"type": "Issue", "number": 42}},
    {"id": "PVTI_ccc", "title": "Componentize the app",
     "status": "Backlog", "content": {"type": "DraftIssue"}},
]


class TestResolveStatus(unittest.TestCase):
    def test_exact(self):
        self.assertEqual(_board.resolve_status(CFG, "Done"), ("Done", "98236657"))

    def test_case_insensitive(self):
        self.assertEqual(_board.resolve_status(CFG, "in progress"),
                         ("In progress", "47fc9ee4"))

    def test_unknown_lists_valid_columns(self):
        with self.assertRaises(_board.BoardError) as ctx:
            _board.resolve_status(CFG, "Finished")
        self.assertIn("Backlog", str(ctx.exception))
        self.assertIn("Finished", str(ctx.exception))


class TestSelectItem(unittest.TestCase):
    def test_by_item_id(self):
        self.assertEqual(_board.select_item(ITEMS, "PVTI_bbb")["title"],
                         "Componentization Wave 2")

    def test_by_issue_number(self):
        self.assertEqual(_board.select_item(ITEMS, "#42")["id"], "PVTI_bbb")
        self.assertEqual(_board.select_item(ITEMS, "42")["id"], "PVTI_bbb")

    def test_by_unique_title_substring(self):
        self.assertEqual(_board.select_item(ITEMS, "minio")["id"], "PVTI_aaa")

    def test_ambiguous_substring_raises_and_lists_matches(self):
        with self.assertRaises(_board.BoardError) as ctx:
            _board.select_item(ITEMS, "componentiz")
        msg = str(ctx.exception)
        self.assertIn("Componentization Wave 2", msg)
        self.assertIn("Componentize the app", msg)

    def test_no_match_raises(self):
        with self.assertRaises(_board.BoardError):
            _board.select_item(ITEMS, "nonexistent thing")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/inventorypro/.claude/skills/board && python3 -m unittest tests.test_board -v`
Expected: FAIL — `AttributeError: module '_board' has no attribute 'resolve_status'`

- [ ] **Step 3: Implement**

Add to `_board.py`:

```python
def resolve_status(cfg: dict, name: str) -> tuple[str, str]:
    """Map a user-typed column name to (canonical_name, option_id)."""
    options = cfg["status_options"]
    for canonical, option_id in options.items():
        if canonical.lower() == name.strip().lower():
            return canonical, option_id
    valid = " | ".join(options)
    raise BoardError(f"unknown column {name!r}. Valid columns: {valid}")


def fetch_items(cfg: dict, runner=None) -> list[dict]:
    """Every item on the board. gh's default limit is 30; ask for more."""
    out = run_gh(
        ["project", "item-list", str(cfg["project_number"]),
         "--owner", cfg["owner"], "--format", "json", "--limit", "500"],
        runner=runner,
    )
    return json.loads(out)["items"]


def select_item(items: list[dict], selector: str) -> dict:
    """Find one item by item id, issue number, or unique title substring."""
    sel = selector.strip()

    for item in items:
        if item["id"] == sel:
            return item

    number = sel.lstrip("#")
    if number.isdigit():
        hits = [i for i in items if i.get("content", {}).get("number") == int(number)]
        if len(hits) == 1:
            return hits[0]
        if not hits:
            raise BoardError(f"no board item for issue #{number}")

    needle = sel.lower()
    hits = [i for i in items if needle in i.get("title", "").lower()]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        raise BoardError(f"no board item matching {selector!r}")
    listing = "\n".join(f"  - {i['title']} ({i['id']})" for i in hits)
    raise BoardError(f"{selector!r} matches {len(hits)} items:\n{listing}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/inventorypro/.claude/skills/board && python3 -m unittest tests.test_board -v`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
cd ~/inventorypro
git add .claude/skills/board/
git commit -m "feat(board): status resolution + fuzzy item selection"
```

---

### Task 4: `gh_list.py`

**Files:**
- Create: `~/inventorypro/.claude/skills/board/scripts/gh_list.py`

**Interfaces:**
- Consumes: `load_config`, `fetch_items`, `BoardError`.
- Produces: CLI `gh_list.py [--status NAME] [--area NAME] [--json]`.

- [ ] **Step 1: Implement**

```python
#!/usr/bin/env python3
"""List InventoryPro board items, optionally filtered by status or area."""
from __future__ import annotations

import argparse
import json
import sys

from _board import BoardError, fetch_items, load_config


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--status", help="filter by column, e.g. 'In progress'")
    ap.add_argument("--area", help="filter by Area field, e.g. 'Fixes'")
    ap.add_argument("--json", action="store_true", help="emit raw json")
    args = ap.parse_args()

    cfg = load_config()
    items = fetch_items(cfg)

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
    try:
        sys.exit(main())
    except BoardError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
```

- [ ] **Step 2: Verify against the live board**

Run: `cd ~/inventorypro/.claude/skills/board/scripts && python3 gh_list.py`
Expected: 89 items listed, ending in `89 item(s)`.

Cross-check the count independently:
```bash
gh project item-list 2 --owner TDHydra --format json --limit 500 \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin)['items']))"
```
Expected: the same number. If they differ, `--limit` is wrong somewhere.

- [ ] **Step 3: Verify filtering**

Run: `python3 gh_list.py --status Done | tail -1`
Expected: `62 item(s)` (as of 2026-07-09; the count may have moved — compare against `gh_list.py --json`).

Run: `python3 gh_list.py --status "no such column" | tail -1`
Expected: `no matching items` (filtering is a plain filter, not a validated lookup — only `gh_move.py` validates).

- [ ] **Step 4: Commit**

```bash
cd ~/inventorypro
git add .claude/skills/board/scripts/gh_list.py
git commit -m "feat(board): gh_list.py"
```

---

### Task 5: `gh_move.py`

**Files:**
- Create: `~/inventorypro/.claude/skills/board/scripts/gh_move.py`
- Modify: `~/inventorypro/.claude/skills/board/scripts/_board.py`

**Interfaces:**
- Produces: `set_status(cfg, item_id, option_id, runner=None) -> None` in `_board.py`; CLI `gh_move.py <selector> <status>`.

- [ ] **Step 1: Add `set_status` to `_board.py`**

```python
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
```

- [ ] **Step 2: Write `gh_move.py`**

```python
#!/usr/bin/env python3
"""Move a board item to a column. Refuses Done and Rejected — use gh_done/gh_reject."""
from __future__ import annotations

import argparse
import sys

from _board import BoardError, fetch_items, load_config, resolve_status, select_item, set_status

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

    item = select_item(fetch_items(cfg), args.selector)
    before = item.get("status") or "—"
    set_status(cfg, item["id"], option_id)
    print(f"{item['title']}\n  {before} → {canonical}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BoardError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
```

`gh_move.py` refuses `Done`/`Rejected` because those transitions must also touch the linked
issue. Routing them through one script each keeps a single writer per transition, which is what
stops the board and the issue tracker from disagreeing.

- [ ] **Step 3: Verify on a scratch item**

Create a scratch draft to move around:
```bash
cd ~/inventorypro/.claude/skills/board/scripts
python3 - <<'EOF'
from _board import load_config, gql
cfg = load_config()
d = gql("""mutation($p:ID!,$t:String!){addProjectV2DraftIssue(input:{projectId:$p,title:$t}){projectItem{id}}}""",
        {"p": cfg["project_id"], "t": "SCRATCH — delete me"})
print(d["addProjectV2DraftIssue"]["projectItem"]["id"])
EOF
```
Note the printed `PVTI_…` id.

Run: `python3 gh_move.py "SCRATCH" "In progress"`
Expected: `SCRATCH — delete me\n  Backlog → In progress`

Run: `python3 gh_move.py "SCRATCH" Ready` then `python3 gh_move.py "SCRATCH" "In review"`
Expected: each prints the transition.

Run: `python3 gh_move.py "SCRATCH" Done`
Expected: exit 1, `error: 'Done' does more than move an item — use gh_done.py …`

Run: `python3 gh_move.py "SCRATCH" Finished`
Expected: exit 1, `error: unknown column 'Finished'. Valid columns: Backlog | Ready | …`

Leave the scratch item in place — Task 7 uses it. Delete it in Task 7's last step.

- [ ] **Step 4: Commit**

```bash
cd ~/inventorypro
git add .claude/skills/board/
git commit -m "feat(board): gh_move.py + set_status, guarding Done/Rejected"
```

---

### Task 6: `gh_add.py`

**Files:**
- Create: `~/inventorypro/.claude/skills/board/scripts/gh_add.py`

**Interfaces:**
- Consumes: `load_config`, `gql`, `run_gh`, `BoardError`.
- Produces: CLI `gh_add.py <title> [--body TEXT] [--draft|--issue] [--status NAME]`. Defaults to `--issue` (live work is issue-backed) and `--status Backlog`.

- [ ] **Step 1: Implement**

```python
#!/usr/bin/env python3
"""Add an item to the board, as a real issue (default) or a draft."""
from __future__ import annotations

import argparse
import json
import sys

from _board import BoardError, gql, load_config, resolve_status, run_gh, set_status

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
    try:
        sys.exit(main())
    except BoardError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
```

- [ ] **Step 2: Verify the draft path**

Run: `python3 gh_add.py "SCRATCH draft — delete me" --draft --status Backlog`
Expected: `draft  SCRATCH draft — delete me\n  → Backlog`

Confirm: `python3 gh_list.py --status Backlog | grep "SCRATCH draft"`

- [ ] **Step 3: Verify the issue path**

Run: `python3 gh_add.py "SCRATCH issue — delete me" --issue --status Ready`
Expected: `#N  SCRATCH issue — delete me\n  → Ready` where N is a real issue number.

Confirm the issue exists and is open:
```bash
gh issue view N --repo TDHydra/inventorypro --json number,state,title
```
Expected: `{"number":N,"state":"OPEN","title":"SCRATCH issue — delete me"}`

- [ ] **Step 4: Clean up both scratch items**

```bash
gh issue close N --repo TDHydra/inventorypro --reason "not planned"
```
Delete both board items via `gh project item-delete 2 --owner TDHydra --id <PVTI_…>`
(get ids from `python3 gh_list.py --json | grep -B2 SCRATCH`).

Leave the `SCRATCH — delete me` item from Task 5 alone; Task 7 needs it.

- [ ] **Step 5: Commit**

```bash
cd ~/inventorypro
git add .claude/skills/board/scripts/gh_add.py
git commit -m "feat(board): gh_add.py, issue-backed by default"
```

---

### Task 7: `gh_done.py` and `gh_reject.py`

**Files:**
- Create: `~/inventorypro/.claude/skills/board/scripts/gh_done.py`
- Create: `~/inventorypro/.claude/skills/board/scripts/gh_reject.py`

**Interfaces:**
- Consumes: everything from `_board.py`.
- Produces: CLI `gh_done.py <selector>`; CLI `gh_reject.py <selector> --reason TEXT`.

`gh_done.py` is the single writer of the `Done` transition. If the item is issue-backed it
closes the issue first, and aborts the move if closing fails — an open issue sitting in `Done`
is the exact inconsistency this design exists to prevent.

- [ ] **Step 1: Write `gh_done.py`**

```python
#!/usr/bin/env python3
"""Move an item to Done and close its linked issue. Refuses to leave them inconsistent."""
from __future__ import annotations

import argparse
import sys

from _board import BoardError, fetch_items, load_config, resolve_status, run_gh, select_item, set_status


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("selector", help="item id, issue number, or title substring")
    args = ap.parse_args()

    cfg = load_config()
    canonical, option_id = resolve_status(cfg, "Done")
    item = select_item(fetch_items(cfg), args.selector)
    content = item.get("content") or {}
    number = content.get("number")

    if number:
        # Close first. If this fails we must NOT move the item.
        run_gh(["issue", "close", str(number), "--repo", cfg["repo"],
                "--reason", "completed"])
        ref = f"#{number} closed"
    else:
        ref = "draft (no issue to close)"

    set_status(cfg, item["id"], option_id)
    print(f"{item['title']}\n  {item.get('status') or '—'} → {canonical}  [{ref}]")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BoardError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
```

- [ ] **Step 2: Write `gh_reject.py`**

```python
#!/usr/bin/env python3
"""Move an item to Rejected, recording why. Closes any linked issue as not-planned."""
from __future__ import annotations

import argparse
import sys

from _board import (BoardError, fetch_items, gql, load_config, resolve_status,
                    run_gh, select_item, set_status)

_UPDATE_DRAFT = """
mutation($d:ID!,$b:String!){
  updateProjectV2DraftIssue(input:{draftIssueId:$d,body:$b}){ draftIssue{ id } }
}"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("selector", help="item id, issue number, or title substring")
    ap.add_argument("--reason", required=True, help="why this is being rejected")
    args = ap.parse_args()

    cfg = load_config()
    canonical, option_id = resolve_status(cfg, "Rejected")
    item = select_item(fetch_items(cfg), args.selector)
    content = item.get("content") or {}
    number = content.get("number")
    note = f"\n\n---\n**Rejected:** {args.reason}"

    if number:
        run_gh(["issue", "comment", str(number), "--repo", cfg["repo"],
                "--body", f"**Rejected:** {args.reason}"])
        run_gh(["issue", "close", str(number), "--repo", cfg["repo"],
                "--reason", "not planned"])
        ref = f"#{number} closed (not planned)"
    else:
        body = (content.get("body") or "") + note
        gql(_UPDATE_DRAFT, {"d": content["id"], "b": body})
        ref = "draft body annotated"

    set_status(cfg, item["id"], option_id)
    print(f"{item['title']}\n  → {canonical}  [{ref}]\n  reason: {args.reason}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BoardError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
```

- [ ] **Step 3: Verify `gh_reject.py` on the draft scratch item**

Run: `python3 gh_reject.py "SCRATCH" --reason "verifying the reject path"`
Expected: `SCRATCH — delete me\n  → Rejected  [draft body annotated]\n  reason: verifying the reject path`

Confirm the body carries the reason:
```bash
python3 gh_list.py --json | python3 -c "
import json,sys
for i in json.load(sys.stdin):
    if 'SCRATCH' in i['title']: print(i['content'].get('body'))
"
```
Expected: ends with `**Rejected:** verifying the reject path`

- [ ] **Step 4: Verify `gh_done.py` closes an issue before moving**

Create a scratch issue-backed item, then complete it:
```bash
python3 gh_add.py "SCRATCH done-path — delete me" --issue --status "In progress"
python3 gh_done.py "SCRATCH done-path"
```
Expected: `… In progress → Done  [#N closed]`

Confirm the issue is actually closed:
```bash
gh issue view N --repo TDHydra/inventorypro --json state --jq .state
```
Expected: `CLOSED`

This is the invariant that matters: no open issue may sit in `Done`.

- [ ] **Step 5: Clean up scratch items**

```bash
python3 gh_list.py --json | python3 -c "
import json,sys
for i in json.load(sys.stdin):
    if 'SCRATCH' in i['title']: print(i['id'])
" | xargs -I{} gh project item-delete 2 --owner TDHydra --id {}
```

Verify none remain: `python3 gh_list.py | grep -c SCRATCH`
Expected: `0`

- [ ] **Step 6: Commit**

```bash
cd ~/inventorypro
git add .claude/skills/board/scripts/
git commit -m "feat(board): gh_done.py + gh_reject.py, single writers of their transitions"
```

---

### Task 8: `gh_promote.py` — rehearsed before it touches Project 2

**Files:**
- Create: `~/inventorypro/.claude/skills/board/scripts/gh_promote.py`

**Interfaces:**
- Produces: CLI `gh_promote.py <selector> [--project-id ID]`. `--project-id` defaults to the real project; the rehearsal passes `rehearsal_project_id`.

`convertProjectV2DraftIssueItemToIssue` has no inverse. Once a draft becomes issue #14, it is an
issue forever. The script therefore prints what it will do and requires `--yes` to proceed.

- [ ] **Step 1: Implement**

```python
#!/usr/bin/env python3
"""Convert a draft board item into a real GitHub issue. IRREVERSIBLE."""
from __future__ import annotations

import argparse
import sys

from _board import BoardError, fetch_items, gql, load_config, select_item

_CONVERT = """
mutation($item:ID!,$repo:ID!){
  convertProjectV2DraftIssueItemToIssue(input:{itemId:$item,repositoryId:$repo}){
    item{ id content{ ... on Issue { number url } } }
  }
}"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("selector", help="item id, or title substring")
    ap.add_argument("--yes", action="store_true", help="required: this cannot be undone")
    args = ap.parse_args()

    cfg = load_config()
    item = select_item(fetch_items(cfg), args.selector)
    content = item.get("content") or {}

    if content.get("type") != "DraftIssue":
        raise BoardError(
            f"{item['title']!r} is already issue #{content.get('number')}; nothing to promote."
        )

    if not args.yes:
        print(f"Would convert draft → real issue in {cfg['repo']}:\n  {item['title']}\n"
              f"\nThis cannot be undone. Re-run with --yes.")
        return 1

    data = gql(_CONVERT, {"item": item["id"], "repo": cfg["repo_id"]})
    issue = data["convertProjectV2DraftIssueItemToIssue"]["item"]["content"]
    print(f"{item['title']}\n  → #{issue['number']}  {issue['url']}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BoardError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
```

- [ ] **Step 2: Verify the dry-run guard**

Run: `python3 gh_promote.py "Componentization Wave 2"`
Expected: exit 1, prints `Would convert draft → real issue …  Re-run with --yes.` and creates nothing.

Confirm nothing was created: `gh issue list --repo TDHydra/inventorypro --limit 5`
Expected: still empty (no issues exist yet at this point).

- [ ] **Step 3: Verify the already-an-issue guard**

This needs an issue-backed item; create and delete one:
```bash
python3 gh_add.py "SCRATCH promote-guard — delete me" --issue
python3 gh_promote.py "SCRATCH promote-guard"
```
Expected: exit 1, `error: 'SCRATCH promote-guard — delete me' is already issue #N; nothing to promote.`

Clean up: close the issue and delete the board item as in Task 7 Step 5.

- [ ] **Step 4: Rehearse the real conversion on Project 3**

Project 3 (`PVT_kwHODJIRY84Bc42n`) is unused. Temporarily point the config at it:

```bash
cd ~/inventorypro/.claude/skills/board
cp references/board.md /tmp/board.md.bak
python3 - <<'EOF'
import re
p = "references/board.md"
t = open(p).read()
t = t.replace('"project_id": "PVT_kwHODJIRY84Bc40q"', '"project_id": "PVT_kwHODJIRY84Bc42n"')
t = t.replace('"project_number": 2', '"project_number": 3')
open(p, "w").write(t)
EOF

cd scripts
python3 gh_add.py "REHEARSAL — promote me" --draft
python3 gh_promote.py "REHEARSAL" --yes
```
Expected: `REHEARSAL — promote me\n  → #N  https://github.com/TDHydra/inventorypro/issues/N`

Confirm the item is now issue-backed on Project 3, then clean up and restore:
```bash
gh issue close N --repo TDHydra/inventorypro --reason "not planned"
cd .. && cp /tmp/board.md.bak references/board.md
git diff --exit-code references/board.md && echo "config restored ✓"
```
Expected: `config restored ✓`

**If `git diff --exit-code` reports changes, stop.** The config is still pointing at Project 3
and the migration in Task 10 would convert the wrong board.

- [ ] **Step 5: Commit**

```bash
cd ~/inventorypro
git add .claude/skills/board/scripts/gh_promote.py
git commit -m "feat(board): gh_promote.py, guarded and rehearsed on project 3"
```

---

### Task 9: `SKILL.md`

**Files:**
- Create: `~/inventorypro/.claude/skills/board/SKILL.md`

- [ ] **Step 1: Write it**

````markdown
---
name: board
description: Use when working with the InventoryPro backlog on GitHub Project 2 — reading what's pending, adding newly discovered work or bugs, moving items between Backlog/Ready/In progress/In review/Done/Rejected, or converting a draft item into a real issue. Triggers on "what's on the backlog", "what should I work on", "add a backlog item", "mark X done", "move X to in progress", "reject X", "file a bug for X", or any mention of the board, the backlog, or Project 2. The board is the single source of truth; docs/BACKLOG-archive-2026-07-09.md is a frozen archive and must not be edited.
---

# InventoryPro board

The backlog lives on **GitHub Project 2**: https://github.com/users/TDHydra/projects/2
Identifiers and column meanings: `references/board.md`.

`docs/BACKLOG-archive-2026-07-09.md` is frozen history. **Never edit it.**

Run scripts from `scripts/`. Every one takes a *selector* — an item id, an issue number
(`42` or `#42`), or a unique title substring.

## Verbs

| Command | Use when |
|---|---|
| `gh_list.py [--status S] [--area A]` | "what's pending", "what should I work on" |
| `gh_move.py <selector> <column>` | starting work, sending to review |
| `gh_add.py <title> [--body B] [--draft] [--status S]` | new bug or discovered work; issue-backed by default |
| `gh_done.py <selector>` | work finished **and** verified |
| `gh_reject.py <selector> --reason "…"` | decided against |
| `gh_promote.py <selector> --yes` | draft → real issue. Irreversible. |

## When to write without asking

These are reversible or cheap-to-undo. Just do them, then say what you did.

- Move to `In progress` when starting work on an item.
- Move to `Ready` when scheduling one.
- `gh_add.py` for a bug or discovered work. A missing item costs more than a spurious one.
- Annotate an item's body with a commit SHA or note.

## When to propose and wait

Being wrong here is expensive. Say what you intend, then wait for the user.

- **`gh_done.py`** — *unless* the change was built into the dev APK, hotloaded, and the user
  confirmed it works. That verification is the one completion signal that isn't Claude's own
  judgment, so in that case move it to `Done` without asking. Otherwise ask.
- **`gh_reject.py`** — discards work and needs a recorded reason.
- **`gh_promote.py`** — cannot be undone.

## Cadence

Reconcile the board after each unit of work: after a plan is written (one `Backlog` item per
plan phase, linked to the spec), when a commit lands, when a todo item completes, after a code
fix. Update the status of the item the work belongs to — do **not** create an item per commit.
Items are units of intent; commits are units of change.

## Gotchas

- `gh_move.py` refuses `Done` and `Rejected`. Those transitions also touch the linked issue, so
  each has its own script and is the single writer of that transition.
- Requires `gh` token scope `project`. If a script says the scope is missing, the user must run
  `gh auth refresh -s project,read:project` — it's interactive; you cannot do it for them.
- Items in `Done`/`Rejected` are drafts; items in the live columns are real issues.
````

- [ ] **Step 2: Verify the skill is discovered**

Run: `ls ~/inventorypro/.claude/skills/board/SKILL.md && head -3 ~/inventorypro/.claude/skills/board/SKILL.md`
Expected: frontmatter with `name: board`.

- [ ] **Step 3: Commit**

```bash
cd ~/inventorypro
git add .claude/skills/board/SKILL.md
git commit -m "feat(board): SKILL.md — triggers, verbs, write-gating rules"
```

---

### Task 10: Migrate the board — reconcile, then promote

**Files:** none (operates on GitHub state)

This task changes live data. Run it only after Tasks 1–9 are green and `references/board.md`
has been confirmed to point at Project 2.

- [ ] **Step 1: Confirm the config points at the real project**

Run:
```bash
cd ~/inventorypro/.claude/skills/board/scripts
python3 -c "from _board import load_config; c=load_config(); print(c['project_number'], c['project_id'])"
```
Expected: `2 PVT_kwHODJIRY84Bc40q`

**If it prints 3, stop.** Task 8's rehearsal did not restore the config.

- [ ] **Step 2: Delete the two superseded backfilled drafts**

The board's finer-grained items supersede two drafts copied from the archived doc:
- "⭐ Componentize the app — extract the repeated cross-screen patterns into a…" is superseded by
  "Componentization Wave 2: ListScreenShell + EntityEditSheet"
- "Shelf picker + proximity location default on the equipment/initial-units add…" is superseded by
  "Wave-0 pickers unused: adopt UserPicker/ItemPicker/LocationShelfPicker", which records that
  `LocationShelfPicker` already exists.

Confirm both, and their supersessors, exist before deleting:
```bash
python3 gh_list.py | grep -i "componentiz\|shelf picker\|wave-0"
```
Expected: four lines — two superseded drafts, two supersessors.

Delete only the two superseded ones:
```bash
python3 gh_list.py --json | python3 -c "
import json,sys
kill = ('Componentize the app', 'Shelf picker + proximity')
for i in json.load(sys.stdin):
    if any(i['title'].startswith(k) for k in kill): print(i['id'], '#', i['title'])
"
```
Review the output, then delete each with
`gh project item-delete 2 --owner TDHydra --id <PVTI_…>`.

Verify: `python3 gh_list.py | tail -1` → `87 item(s)`

- [ ] **Step 3: Promote every live item to a real issue**

Live = any status other than `Done`/`Rejected`. 19 before Step 2; **17 after**.

List them first:
```bash
python3 gh_list.py --json | python3 -c "
import json,sys
live=[i for i in json.load(sys.stdin) if i.get('status') not in ('Done','Rejected')]
print(len(live),'to promote')
for i in live: print(' ', i['content']['type'], i['title'][:60])
"
```
Expected: `17 to promote`, all `DraftIssue`.

Promote one first and check it:
```bash
python3 gh_promote.py "Pin MinIO" --yes
gh issue list --repo TDHydra/inventorypro --limit 3
```
Expected: one open issue whose title matches, and `gh_list.py` shows it as `#N` not `draft`.

Then the rest, one at a time, pausing on any error:
```bash
python3 gh_list.py --json | python3 -c "
import json,sys
for i in json.load(sys.stdin):
    if i.get('status') not in ('Done','Rejected') and i['content']['type']=='DraftIssue':
        print(i['id'])
" | while read id; do python3 gh_promote.py "$id" --yes || break; done
```

- [ ] **Step 4: Verify the invariant**

```bash
python3 gh_list.py --json | python3 -c "
import json,sys
d=json.load(sys.stdin)
live=[i for i in d if i.get('status') not in ('Done','Rejected')]
arch=[i for i in d if i.get('status') in ('Done','Rejected')]
bad_live=[i['title'] for i in live if i['content']['type']!='Issue']
bad_arch=[i['title'] for i in arch if i['content']['type']!='DraftIssue']
print('live items, all issues:', not bad_live, bad_live[:3])
print('archive items, all drafts:', not bad_arch, bad_arch[:3])
print('open issues in Done:', [i['title'] for i in d if i.get('status')=='Done' and i['content']['type']=='Issue'])
"
```
Expected: `True []`, `True []`, and an empty list of open issues in `Done`.

- [ ] **Step 5: Record the migration**

```bash
cd ~/inventorypro
git commit --allow-empty -m "chore(board): promote 17 live items to real issues; board is the backlog"
```

---

### Task 11: The conditional `Stop` hook

**Files:**
- Create: `~/inventorypro/.claude/hooks/board_reminder.sh`
- Create: `~/inventorypro/.claude/settings.json`

The hook fires when Claude finishes a turn. It must only speak when a commit landed during that
turn, or it becomes wallpaper. It records the SHA it last reported **before** signalling, so it
cannot fire twice for the same commit and cannot trap the session in a loop.

- [ ] **Step 1: Write the hook**

```bash
#!/usr/bin/env bash
# Stop hook: remind Claude to reconcile the board when a commit landed this turn.
# Silent on conversational turns. Records the SHA before signalling, so it fires
# at most once per commit and can never loop.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-$PWD}" || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
[ "$branch" = "main" ] && exit 0
[ -z "$branch" ] && exit 0

head=$(git rev-parse HEAD 2>/dev/null || exit 0)
seen_file="$(git rev-parse --git-dir)/board-last-seen"
seen=$(cat "$seen_file" 2>/dev/null || echo "")

[ "$head" = "$seen" ] && exit 0

# Record BEFORE signalling: if we exit 2 first and the write never happens,
# the next Stop fires again on the same SHA and the session cannot end.
printf '%s' "$head" > "$seen_file"

subject=$(git log -1 --format=%s)
cat >&2 <<EOF
A commit landed this turn: ${head:0:8} — ${subject}

Reconcile the board (skill: board). Which item does this commit belong to?
  - Move it to 'In progress' or 'In review' if that reflects reality (no need to ask).
  - If the work is finished AND you hotloaded the dev APK and the user confirmed it
    works, run gh_done.py. Otherwise propose Done and wait.
  - If this commit revealed new work, gh_add.py it.
EOF
exit 2
```

Make it executable: `chmod +x ~/inventorypro/.claude/hooks/board_reminder.sh`

- [ ] **Step 2: Register it**

Create `~/inventorypro/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/board_reminder.sh"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Verify it stays silent with no new commit**

```bash
cd ~/inventorypro
rm -f "$(git rev-parse --git-dir)/board-last-seen"
git rev-parse HEAD > "$(git rev-parse --git-dir)/board-last-seen"
CLAUDE_PROJECT_DIR=~/inventorypro bash .claude/hooks/board_reminder.sh; echo "exit=$?"
```
Expected: no output, `exit=0`

- [ ] **Step 4: Verify it fires once on a new commit, then goes quiet**

```bash
git commit --allow-empty -m "test: hook fires"
CLAUDE_PROJECT_DIR=~/inventorypro bash .claude/hooks/board_reminder.sh; echo "exit=$?"
```
Expected: the reminder on stderr, `exit=2`

Immediately again:
```bash
CLAUDE_PROJECT_DIR=~/inventorypro bash .claude/hooks/board_reminder.sh; echo "exit=$?"
```
Expected: no output, `exit=0` — proves it cannot loop.

Clean up: `git reset --hard HEAD~1`

- [ ] **Step 5: Verify it stays silent on `main`**

```bash
git switch main
CLAUDE_PROJECT_DIR=~/inventorypro bash .claude/hooks/board_reminder.sh; echo "exit=$?"
git switch -
```
Expected: no output, `exit=0`

- [ ] **Step 6: Commit**

```bash
cd ~/inventorypro
git add .claude/hooks/board_reminder.sh .claude/settings.json
git commit -m "feat(board): Stop hook reminding to reconcile the board after a commit"
```

Add `board-last-seen` to nothing — it lives inside `.git/`, which is already not tracked.

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: archive (already done, commit
`15a5a17`), real-issues-for-live-work (Tasks 6, 8, 10), risk-gated writes (Tasks 5, 7, 9 —
`gh_move.py` refuses guarded transitions, `SKILL.md` states the rules), behavior-named scripts
(Tasks 4–8), both GraphQL traps (Task 2 test asserts `-f`; `references/board.md` documents the
option-ID trap, and no script calls `updateProjectV2Field`), the `Stop` hook (Task 11),
planning integration (`SKILL.md` cadence section), migration incl. Project 3 rehearsal
(Tasks 8, 10), verification (each task's live-board steps).

**Placeholders.** None. Every code step carries complete code; every verify step carries the
command and its expected output.

**Type consistency.** `load_config → dict`, `resolve_status → (str, str)`, `select_item → dict`,
`set_status → None`, `fetch_items → list[dict]`, `gql(query, variables, runner=None) -> dict`,
`run_gh(args, runner=None) -> str`. Names are identical across Tasks 1–8. `content.type` is
`"Issue"` or `"DraftIssue"` everywhere. `--yes` is the confirmation flag in `gh_promote.py` only.

**Known gap, accepted.** The verb scripts have no unit tests — only live-board verification.
Mocking GitHub's responses would test my guesses about them, not GitHub. `_board.py` holds the
logic worth testing and is covered.
