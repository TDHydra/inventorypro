# GitHub Board Skill — Design

**Date:** 2026-07-09
**Status:** Approved, pending implementation plan

## Problem

InventoryPro's backlog lives in two places that disagree. `docs/BACKLOG.md` is a 149-line
checklist in git; GitHub Project 2 is a board that, as of 2026-07-09, holds all 78 of that
file's items backfilled as draft issues plus 11 finer-grained items of live work. The two
already contradict each other: the doc lists "Componentize the app" and "Shelf picker →
extract reusable components" as pending, while the board records that `LocationShelfPicker`
exists but is unadopted and componentization has reached Wave 2.

Nothing keeps them in sync, and nothing tells a future session which to trust.

## Goals

1. Make GitHub Project 2 the single source of truth for InventoryPro's backlog.
2. Retire `docs/BACKLOG.md` without losing the verification evidence it carries.
3. Give Claude a skill that knows when to read the board, when to write to it, and which
   writes require the user's confirmation.
4. Keep the board current enough to be a reliable visual overview of what has been done and
   what remains.

## Non-goals

- A general, multi-repo GitHub board tool. This targets InventoryPro. The scripts are written
  to hardcode nothing so they can be promoted later, but no configuration layer is built now.
- Mirroring `docs/BACKLOG.md` from the board. The file is frozen, not generated.
- One board item per commit. Items are units of intent; commits are units of change.

## Decisions

### `docs/BACKLOG.md` becomes a frozen archive

Rename to `docs/BACKLOG-archive-2026-07-09.md` and prepend a header stating that it is
historical and that the live backlog is Project 2. No further edits, ever. Update the pointer
at `docs/STATUS.md:9` — the file's only inbound reference — to name the project URL instead.

The file is kept rather than deleted because 46 of its 78 items are completed work carrying
`*(verified: …)*` notes naming specific files and functions. That evidence is archaeology: it
describes work already done, so it can never fall out of sync with anything. Regenerating it
from the board was considered and rejected — it would mean maintaining a generator for a file
nobody may edit, and a stale checkout would look authoritative when it is not.

### Real issues for live work, drafts for history

Items in `Backlog`, `Ready`, `In progress`, and `In review` become real GitHub issues, so a PR
can close them and a commit can cite them. Existing commit messages already write `(#35)` and
`(#74)`; today those numbers refer to backlog-doc lines and point at nothing. Under this design
they resolve.

Items in `Done` and `Rejected` stay draft issues. They are archaeology; nothing will ever link
to them, and opening seventy issues only to close them immediately would make the issue tracker
unusable.

This gives `Done` two representations — a closed issue and a board column — which can disagree.
`gh_done.py` is responsible for keeping them consistent and refuses to move an issue-backed item
to `Done` without closing its issue.

### Writes are gated by risk, not uniformly

The user asked for status updates at high frequency: after planning completes, after a commit
lands, after a todo item is ticked, after each code fix. Requiring confirmation for every write
at that cadence would train reflex-approval, which resembles oversight without providing it.

Transitions therefore differ by the cost of being wrong:

| Transition | Behavior | Rationale |
|---|---|---|
| → `In progress` | automatic | Reversible; asserts nothing about correctness. |
| → `Ready` | automatic | Reversible. |
| Create item (bug, discovered work, plan phase) | automatic | A spurious item is cheap to delete; a missing one is work forgotten. |
| Annotate body (commit SHA, notes) | automatic | Pure annotation. |
| → `Done`, after a verified hotload | automatic | The completion signal is the user confirming the build works on-device, not Claude's judgment. |
| → `Done`, otherwise | **proposes, waits** | A truth claim. Being wrong means the user stops checking something broken. |
| → `Rejected` | **proposes, waits** | Discards work; requires a recorded reason. |
| Draft → real issue | **proposes, waits** | Irreversible. |

The `Done`-after-hotload carve-out is narrow by design. It rides the checkpoint `CLAUDE.md`
already mandates ("after each successful phase, build the dev expo APK and hotload it"), which
is the one moment where completion is an observed fact the user signed off on rather than a
judgment Claude made about its own work.

### Scripts are named by behavior, not by destination

A script per column (`gh_in-progress`, `gh_done`, `gh_rejected`, …) would be six files differing
only in a hardcoded option ID — six copies of one bug, and a seventh file the day a column is
added. The destination is a lookup, not a behavior.

| Script | Responsibility |
|---|---|
| `gh_list.py` | Read the board; filter by status and area. |
| `gh_move.py` | `gh_move.py <item> <status>` — any column; validates the status name. |
| `gh_add.py` | Create an item; `--issue` files a real issue, `--draft` a draft. |
| `gh_done.py` | Move to `Done` **and** close the linked issue; refuse if issue-backed and unclosable. |
| `gh_reject.py` | Move to `Rejected` **and** append the reasoning to the body. |
| `gh_promote.py` | Convert a draft to a real issue. Irreversible. |

`gh_done.py` and `gh_reject.py` exist separately because they do more than move. `In progress`,
`Ready`, `Backlog`, and `In review` have no such extra behavior and are reached through
`gh_move.py`.

## Architecture

```
~/inventorypro/.claude/skills/board/
  SKILL.md                 trigger + when to use which verb
  references/board.md      every InventoryPro-specific fact (IDs, columns, the hotload rule)
  scripts/
    _board.py              shared: auth check, GraphQL call, status/area lookup
    gh_list.py
    gh_move.py
    gh_add.py
    gh_done.py
    gh_reject.py
    gh_promote.py
```

`scripts/` hardcodes no IDs; every identifier arrives as an argument or is read from
`references/board.md`. `references/board.md` is the only file that knows this is InventoryPro.
Promoting the skill to a general one later means moving `scripts/` to `~/.claude/skills/`
unchanged and forking the reference file. No configuration layer is built until a second repo
exists to justify it.

### Board facts (as of 2026-07-09)

Project 2, owner `TDHydra`, id `PVT_kwHODJIRY84Bc40q`.

Status field `PVTSSF_lAHODJIRY84Bc40qzhXeW4E`:
`Backlog` `f75ad846` · `Ready` `e18bf179` · `In progress` `47fc9ee4` ·
`In review` `aba860b9` · `Done` `98236657` · `Rejected` `5da22600`

Area field `PVTSSF_lAHODJIRY84Bc40qzhXecgY`, 13 options.
Priority field `PVTSSF_lAHODJIRY84Bc40qzhXeXFM`.

### Two GraphQL traps, encoded in code rather than prose

Both were hit while backfilling the board on 2026-07-09. They are the reason this skill has
scripts at all.

1. **`gh api graphql -F` coerces numeric-looking strings to `Int`.** Option IDs like
   `"98236657"` fail against a `String!` variable. `_board.py` always uses `-f`.

2. **`updateProjectV2Field` replaces the entire single-select option list.** Omitting the `id`
   of an existing option recreates it with a fresh ID and silently clears that status from every
   item on the board. Any script touching field options must pass every existing option with its
   ID. This would have destroyed the status of all 11 pre-existing items.

## Enforcement

A `Stop` hook fires when a turn ends and reminds Claude to reconcile the board — but only when
the turn touched tracked state, so conversational turns stay quiet. The condition is a commit
landing on a feature branch, which in this repo correlates closely with a completed unit of work.

An unconditional hook was rejected: it would fire on every turn, including "what does this
function do," and become wallpaper. A `CLAUDE.md` line alone was rejected as advisory — it works
while Claude is attentive and fails in long sessions, which is exactly when the board goes stale.

The hook is built after the skill, so it has something to call.

## Planning integration

When an implementation plan is written, the skill creates one `Backlog` item per plan phase,
linked to the spec file. The board then shows the shape of upcoming work, not only completed
work. The plan's individual steps do not become items — filing six items to build a six-script
tool is ceremony. One item per phase.

## Migration

1. Archive `docs/BACKLOG.md`; fix the `docs/STATUS.md` pointer.
2. Reconcile the two known stale items against reality: the board's finer-grained
   "Componentization Wave 2" and "Wave-0 pickers unused" supersede the doc's "Componentize the
   app" and "Shelf picker → extract reusable components". Delete the superseded backfilled
   drafts.
3. Promote the live items (`Backlog`/`Ready`/`In progress`/`In review`) from drafts to real
   issues — 19 as of 2026-07-09, 17 after step 2 removes the two superseded drafts. Test
   `gh_promote.py` against one throwaway draft in the unused Project 3 first —
   `convertProjectV2DraftIssueItemToIssue` cannot be undone.
4. Build the `Stop` hook.

## Verification

Each script is exercised against the live board before being called done, since a script that
merely typechecks proves nothing here:

- `gh_list.py` returns every item (89 as of 2026-07-09) and its status counts match a manual
  `gh project item-list`.
- `gh_move.py` moves a scratch item through every column and back.
- `gh_add.py --draft` and `--issue` each create, and the issue variant returns a usable number.
- `gh_done.py` refuses an issue-backed item whose issue it cannot close.
- `gh_reject.py` records the reason in the body.
- `gh_promote.py` is proven on Project 3 before touching Project 2.

Every script exits nonzero with a readable message on failure. The backfill run silently
`continue`d past errors and left an orphaned item with no status; these scripts fail loudly.

## Risks

- **`gh_promote.py` is irreversible.** Mitigated by rehearsing on Project 3 and by requiring
  confirmation before each promotion.
- **The board and the issue tracker can disagree** about what `Done` means. `gh_done.py` is the
  single writer for that transition, which is why it exists as its own script.
- **The `Stop` hook's condition may be wrong.** If "a commit landed" turns out to be the wrong
  proxy for "a task finished," the fallback is the advisory `CLAUDE.md` line.
- **Automatic item creation can accumulate noise.** Accepted deliberately: a missing item costs
  more than a spurious one, and spurious items are one `gh project item-delete` away.
