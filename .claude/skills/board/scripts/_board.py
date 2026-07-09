"""Shared GitHub Project board access for the board skill's verb scripts.

Imported by sibling scripts via `from _board import ...`.
Knows no InventoryPro identifiers; everything comes from references/board.md.
"""
from __future__ import annotations

import json
import os
import re
import subprocess

_REF = os.path.join(os.path.dirname(__file__), "..", "references", "board.md")


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


def cli(main_fn) -> "NoReturn":
    """Shared entry point for every verb script. Exits nonzero with a readable message."""
    import sys

    try:
        sys.exit(main_fn())
    except BoardError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
