---
name: board
description: Use when working with the InventoryPro backlog on GitHub Project 2 — reading what's pending, adding newly discovered work or bugs, moving items between Backlog/Ready/In progress/In review/Done/Rejected, or converting a draft item into a real issue. Triggers on "what's on the backlog", "what should I work on", "add a backlog item", "mark X done", "move X to in progress", "reject X", "file a bug for X", or any mention of the board, the backlog, or Project 2. The board is the single source of truth; docs/BACKLOG-archive-2026-07-09.md is a frozen archive and must not be edited.
---

# InventoryPro board

The backlog lives on **GitHub Project 2**: https://github.com/users/TDHydra/projects/2
Identifiers and column meanings: `references/board.md`.

`docs/BACKLOG-archive-2026-07-09.md` is frozen history. **Never edit it.**

Run scripts from `scripts/`. Every one takes a *selector* — an item id (`PVTI_…`), an issue
number (`42` or `#42`), or a **unique** title substring. An ambiguous substring is refused,
with the matching titles listed so you can narrow it.

## Verbs

| Command | Use when |
|---|---|
| `gh_list.py [--status S] [--area A] [--json]` | "what's pending", "what should I work on" |
| `gh_move.py <selector> <column>` | starting work, sending to review |
| `gh_add.py <title> [--body B] [--draft \| --issue] [--status S]` | new bug or discovered work; real issue by default (`--status` defaults to `Backlog`) |
| `gh_done.py <selector>` | work finished **and** verified |
| `gh_reject.py <selector> --reason "…"` (required) | decided against |
| `gh_promote.py <selector> --yes` | draft → real issue. Irreversible; dry-runs without `--yes`. |

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

- `gh_move.py` refuses `Done` and `Rejected`. Those transitions also touch the linked GitHub
  issue (closing it, or commenting + closing as not-planned), so each has exactly one writer —
  `gh_done.py` / `gh_reject.py` — and no other path may set those columns. The invariant this
  protects: **no open issue may sit in the `Done` column.**
- Requires `gh` token scope `project`. If a script reports the scope is missing, the user must
  run `gh auth refresh -s project,read:project` themselves — it's interactive, so Claude cannot
  do it for them.
- `gh project item-list` (used by every verb here to read the board) is **GraphQL** and counts
  against a 5,000/hr GraphQL quota shared across all concurrent agents on this account;
  `gh issue list` is REST and draws from a separate quota. Bulk board operations can exhaust the
  GraphQL quota fast — read the item list once and reuse it for a batch of moves rather than
  re-querying per item.
- The Projects API is **read-after-write eventually consistent**: an item just created or moved
  can briefly be missing (or stale) in the next `item-list` read. If a just-created item seems
  absent, retry the read before concluding the write failed.
- A Projects workflow named "Auto-add to project" is enabled on this repo, so newly created
  issues land on the board on their own even without `gh_add.py`'s explicit
  `addProjectV2ItemById` call. That mutation is idempotent per content id, so calling it again
  for an issue that's already on the board does not create a duplicate item.
- Issues can be closed but never deleted — creating one is permanent. Use `gh_add.py --draft`
  when you only need a board item (e.g. speculative or rejected-on-arrival work), not a real
  issue.
- Items in the live columns (`Backlog`/`Ready`/`In progress`/`In review`) are real issues, so
  commits and PRs can cite them. `Done`/`Rejected` hold a mix: the 70 items backfilled from the
  archived backlog are drafts, while work completed since is a **closed issue** that `gh_done.py`
  moved there. Do not assume a `Done` item is a draft. The invariant is only that **no OPEN issue
  sits in `Done`.**
