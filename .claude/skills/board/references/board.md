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
