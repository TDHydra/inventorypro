# legacy-v1 — ARCHIVED, NOT DEPLOYED

This folder holds the **original (V1) app and API**, moved here 2026-09-30 so
the live code is unambiguous:

| Was | Now |
| --- | --- |
| `apps/mobile` | `legacy-v1/mobile` |
| `apps/api` | `legacy-v1/api` |
| `infra/Dockerfile.web` | `legacy-v1/infra/Dockerfile.web` |
| `infra/Dockerfile.allinone` + `infra/allinone/` | `legacy-v1/infra/` |

## What is live

Production (`api.invenpro.app` / `invenpro.app`, VPS 74.91.114.166) runs the
**lean rebuild** only:

- **API** — `apps/api-v2` (`inventorypro-api-v2`, both blue/green pins)
- **Web + Android** — `apps/mobile-v2` (web image built from
  `infra/Dockerfile.web-v2`)

Work on `apps/*-v2`. Nothing in `legacy-v1/` is built, tested, deployed, or
part of the pnpm workspace (`apps/*` + `packages/*`) any more.

## Why it is kept

Reference material for the rebuild: the V1 tree is the source the v2 screens
were ported from, and ~180 comments in `apps/mobile-v2` / `apps/api-v2` cite
`apps/mobile/...` / `apps/api/...` paths as their porting provenance. Those
comments were deliberately **not** rewritten — read them as `legacy-v1/mobile`
and `legacy-v1/api`.

Delete this folder once the rebuild no longer needs the reference.
