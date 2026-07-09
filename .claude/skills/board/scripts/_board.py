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
