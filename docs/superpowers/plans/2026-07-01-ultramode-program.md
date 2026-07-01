# Ultramode Program — API Redeploy + Telemetry + Push (master orchestration)

> **For agentic workers:** this is a MASTER plan coordinating four workstreams. Task-level code lives in the sub-plans it references. Executed via parallel implementer subagents (build) + controller-driven sequential deploys (prod). Deploys are GATED on the user.

**Goal:** Get everything built-but-unshipped **live on prod**, then build **Telemetry** and **Push Foundation** in parallel and ship them — without migration collisions, shared-file clobbering, or a broken prod.

**Workstreams:**
- **WS-A — API Redeploy** (Phase 0+1+2 → prod). *Phase 2 is already code-complete; "doing Phase 2" = shipping it here.* Sequential prod deploy, migrations 027 (drop `teams.manager_id`) + 028 (repair fields + `repair_parts`).
- **WS-B — Telemetry** — plan `docs/superpowers/plans/2026-07-01-telemetry.md`.
- **WS-C — Push Foundation** — plan `docs/superpowers/plans/2026-07-01-push-foundation.md`.

---

## 0. Pre-resolved conflicts (MUST honor — this is why we plan first)

**Migration-number collision:** both sub-plans reserved API `029`. Resolved:
- **Telemetry `telemetry_events` = API `029`** (mobile `telemetry_buffer` = `024`).
- **Push `device_push_tokens` = API `030`** (no mobile migration). *(Push sub-plan says 029 — override to 030 at build time.)*
- Both are **server-only, additive, non-synced** — order is functionally irrelevant, only the file numbers must be distinct + sequential.

**Shared-file contention (the only real overlap between WS-B and WS-C):**
| File | Telemetry needs | Push needs | Rule |
|---|---|---|---|
| `apps/api/src/index.ts` | register `/telemetry` | register `/push` | **Controller** adds BOTH registrations in one integration step — agents do NOT touch index.ts |
| `apps/mobile/app/_layout.tsx` | error boundary + nav-screen tracker | notification handlers/observers | **Controller** wires BOTH in one integration step — agents do NOT touch _layout.tsx |
| `apps/api/src/db/migrate.ts` | 90-day prune | — | Telemetry agent only |
| `schema.ts` / `schema.web.ts` | register `m024` | — | Telemetry agent only |
| `sync/engine.ts` | flush hook | — | Telemetry agent only |
| `auth/finishLogin.ts` | — | `registerForPush()` | Push agent only |
Everything else is disjoint. **No `package.json`/lockfile changes** in either (both use built-in `fetch`; Expo Push needs no `firebase-admin`) → no dep contention.

**Prod DB is at migration 026.** WS-A boot runs 027+028; WS-C-deploy boot runs 029+030.

---

## Phase I — WS-A: ship what's already built (sequential, GATED)
Aligns prod with the deployed clients and fixes the `recount` stuck-outbox. Follow the `deploy-api` skill.

1. **Pre-flight:** `cd apps/api && npx tsc --noEmit && npm test` (23/23); `pnpm install --frozen-lockfile --filter api...` = "up to date"; confirm prod `.env` still has `CORS_ORIGINS`, `TRUST_PROXY`, MinIO creds (set earlier this session).
2. **Backup for rollback:** on Unraid, `docker tag inventorypro-api:latest inventorypro-api:prev` before loading the new image (so we can `docker tag prev latest && compose up -d --force-recreate api` to roll back).
3. **Build + ship + recreate** `--force-recreate --no-deps api`; watch logs for `✓ Migration 27 applied`, `✓ Migration 28 applied`, `Server listening`.
4. **Verify:** `curl https://api.invenpro.app/health`; `schema_max=28`; `\d repairs` shows `assignee_id/cost/due_at`; `repair_parts` exists; `teams.manager_id` gone. Prod smoke (crew JWT): the Phase 0/1/2 authz still blocks the known vectors.
5. **Post-deploy:** existing stuck `recount` outbox entries on devices flush on next sync (now accepted). Push branch already pushed.

**Gate:** do not proceed to prod recreate without the user's go. Rollback = re-tag `prev` → recreate.

---

## Phase II — WS-B + WS-C: build in parallel (ultramode)
Two implementer subagents in parallel (disjoint files per §0), **neither touching `index.ts` or `_layout.tsx`**. Controller verifies (`tsc`+tests), then does the shared-file integration, then commits.

- **Agent B (Telemetry):** build the telemetry plan tasks — `telemetry_events` (API 029) + prune, `POST /telemetry` + `sanitizeEvent` (+`node:test`), `telemetry_buffer` (m024) + schema reg, tracker/redactor (+mobile `node:test`), flush + engine hook, capture (screens/taps/errors/friction), audit blend. **Skips** `index.ts` route-register + `_layout.tsx` wiring.
- **Agent C (Push):** build the push plan tasks — `device_push_tokens` (**API 030**, not 029), `sendPush` + receipts (+`node:test`), `/push` routes, client `registerForPush`/handlers, app.json config. **Skips** `index.ts` route-register + `_layout.tsx` wiring; leaves EAS/Firebase-MCP setup for Phase III.
- **Controller integration step (after both land):** register `/telemetry` + `/push` in `index.ts`; wire the telemetry error-boundary+nav-tracker AND push notification-observers into `_layout.tsx`; run full `tsc`+tests (api + mobile) together; resolve any seam issues.
- **Adversarial review:** one reviewer per workstream (telemetry: PII-leak / buffer-cap / flush-never-blocks; push: token lifecycle / dead-token disable / fire-and-forget), plus a seam review of the integrated `index.ts`/`_layout.tsx`. Fix findings.
- **Commit** per workstream + the integration commit; push branch.

---

## Phase III — deploy the new server pieces + clients (GATED)
1. **API redeploy #2:** build+ship the image now carrying telemetry+push server code; boot runs migrations **029 (telemetry_events)** + **030 (device_push_tokens)**. Verify both tables exist; `/telemetry` and `/push/*` respond (401 unauth, accept authed). Rollback via the `prev` tag.
2. **Firebase MCP (controller):** register Android app `com.inventorypro.app` on `invenpro-e6aaf`, fetch `google-services.json` → `apps/mobile/google-services.json` (gitignored), add release SHA.
3. **Web rebuild/redeploy** (telemetry web capture) → `invenpro.app`.
4. **USER actions (cannot automate):** `eas credentials` upload the FCM V1 service-account key; `eas build -p android`; install the EAS build. Then validate push via `POST /push/test`, and telemetry by navigating + confirming events land in `telemetry_events` (and NO PII in `props`).

---

## Every-outcome contingency table
| Risk / outcome | Likelihood | Mitigation / handling |
|---|---|---|
| Migration 027 (drop `manager_id`) breaks a reader | Low (Phase-0 removed all readers; seeds fixed) | Verified in Phase-0 review; `DROP COLUMN IF EXISTS` idempotent; rollback via `prev` image (column re-add not needed since additive elsewhere). |
| API won't boot after redeploy (bad env / helmet / media creds) | Low | Pre-flight `.env` check; helmet pinned v11; media fail-closed creds present. If boot fails → re-tag `prev` + recreate (≤1 min). |
| Migration 029/030 collision or wrong order | Medium if unmanaged | §0 fixes numbers (telemetry 029, push 030); controller verifies file numbers before build. |
| Telemetry/Push both edit `index.ts`/`_layout.tsx` → conflict | High if parallel-unmanaged | §0: agents skip those; controller integrates. |
| Telemetry floods sync / blocks UI | Medium | Separate buffer + endpoint (never the sync outbox); ring-cap 2000; batch flush; `track()` wrapped in try/catch, never throws. |
| Telemetry captures PII | Medium | Server + client allowlist redactor (unit-tested); verify grep of `telemetry_events.props` post-deploy. |
| Push won't deliver on the local gradle APK | Certain (by design) | Requires an EAS build — documented as a USER action; local APK unaffected for everything else. |
| FCM creds / EAS build not done | External dependency | Phase III blocks only push *delivery*; all code + `device_push_tokens` + `/push/test` ship regardless; user completes creds when ready. |
| `recount` stuck-outbox entries pre-existing on devices | Present now | WS-A deploy adds the enum entry → they flush on next sync; no data loss (stock already wrote). |
| Two prod deploys (Phase I + III) cause downtime | Low | `--force-recreate --no-deps api` is seconds; Postgres/MinIO untouched; NPM/Cloudflare in front. |
| A subagent edits outside its file set | Low | Explicit file allowlists per agent; controller `git status` review before commit. |
| Telemetry migration 029 vs a future manual 029 | Low | Controller confirms next-free number at build time. |

---

## Verification gates (each phase)
- Code: `cd apps/api && npx tsc --noEmit && npm test`; `cd apps/mobile && npx tsc --noEmit -p tsconfig.json` (+ mobile `npm test` for redactor). Pull.ts parity: **N/A** — both new tables are non-synced.
- Prod (post each deploy): health 200; schema at expected version; new tables/columns present; endpoints authz-correct; rollback image (`prev`) confirmed present.
- On-device (Phase III, after EAS build): push `/push/test` arrives; telemetry events land with no PII.

## Sequencing summary
**Phase I (deploy current, gated) → Phase II (build telemetry+push in parallel + integrate + review) → Phase III (deploy new + Firebase MCP + web rebuild; user does EAS creds+build).** Telemetry has zero external deps and can ship fully in Phase III; Push ships its code/server in Phase III but full delivery waits on the user's EAS step.
