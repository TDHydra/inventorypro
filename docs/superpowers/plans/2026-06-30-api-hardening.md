# Plan — API & Infrastructure Hardening (comprehensive)

## Context
Two security passes already shipped + are deployed/verified: sync authz + `is_manager`/attribution sanitize, `/sync/full` auth, `/users` self-escalation fix, media authz + validation + perm-respecting delete, PIN rate-limit + login-error unification + 7d refresh, CORS allowlist + `JWT_SECRET` length guard + per-user mutation rate-limit, the gated manager-promotion endpoint. Those closed the **exploitable** holes. This plan is **defense-in-depth + ops + the deferred architecture items** — what a production-grade API needs next. Scope: `apps/api` + `infra`. Grounded in a read-only recon (2026-06-30).

Reuse existing patterns: `userHasPermission`/`requirePermission`/`callerCan` (`lib/permissions.ts`), the in-memory limiter (`lib/rateLimit.ts`), the token-minting verification harness used this session (`sectest.js`), the deploy flow (`infra/DEPLOY-COMMANDS.md`).

---

## Phase 1 — P0 quick wins (high impact, low/medium effort)
1. **Security response headers (`@fastify/helmet`)** — register in `index.ts`; sets HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, and a minimal CSP for API responses. (S)
2. **Global error handler** — `fastify.setErrorHandler` in `index.ts`: log the real error, return a generic `{error:'Internal error'}` + 500 to clients (no stack/DB message leak). Audit existing `reply.send({error: err.message})` sites (e.g. `sync.ts` conflict log already only logs server-side — fine; ensure no handler returns raw `err.message` for unexpected errors). (S)
3. **Request schemas on every route** — add Fastify `schema:{body|params|querystring}` to the ~17 routes missing it (items, locations, jobs, logs, labels, media GET/DELETE, sync GET, teams GET/DELETE). Add `type`, `minLength/maxLength`, integer coercion for `page/limit/offset`. Pattern: copy the schema style already on `auth.ts`/`users.ts` POSTs. (M)
4. **Rate-limit read + refresh endpoints** — the global hook only covers POST/PATCH/DELETE and skips `/auth`. Add a per-user limit to expensive GETs (`/sync/full`, `/sync/pull`, `/logs`, `/items` search) and to `POST /auth/refresh` (a refresh-token holder can hammer it). Reuse `overRateLimit` with per-endpoint keys/limits. (M)
5. **Sync `/push` operational-table authorization** — today only privileged tables are gated; any authenticated user can INSERT/UPDATE `inventory_items`/`jobs`/`locations`/`repairs`/`stock_by_location`/`media` via the outbox with no per-action check. Add a per-table → required-permission map (e.g. `inventory_items`→`add_inventory`/`edit_inventory`, `jobs`→`create_jobs`, `locations`→`manage_locations`, `stock_by_location`→`checkout_inventory`/`checkin_inventory`, `repairs`→`edit_inventory`) gating push entries via `userHasPermission`, mirroring the existing `PRIVILEGED_TABLE_PERM` gate. Be careful to keep legitimate offline crew writes (stock moves, item creation by add-permitted roles) working — verify against `ROLE_DEFAULTS` before tightening. (M)

## Phase 2 — P1 infrastructure & ops
6. **CI/CD pipeline** (`.github/workflows/ci.yml`) — on PR: `pnpm install`, `tsc --noEmit` (api + mobile), lint, and `pnpm audit --audit-level=high`; enable Dependabot for the three `package.json`s. Fails the build on high/critical CVEs. (M)
7. **MinIO: drop anonymous download → presigned GET** — remove `mc anonymous set download` from `docker-compose.prod.yml`; pair with the presigned-GET media route (Phase 3 #11). Until then, media is capability-URL (uuid keys, no listing). (S now / M with #11)
8. **Least-privilege Postgres role** — run the API as a non-DDL role (SELECT/INSERT/UPDATE/DELETE on app tables only); run migrations under a separate privileged role at deploy time. Limits blast radius of any future injection. (M)
9. **Automated DB backups** — scheduled `pg_dump` (cron on the Unraid box or a sidecar) to a retained location + a documented restore test; today backups are manual. (M)
10. **Structured logging + redaction + security events** — ensure Pino never logs tokens/PINs/PII (add redaction paths); log security events (failed auth, authz denials, rate-limit hits) with structured fields for later alerting. `sync.ts` already logs push conflicts — extend the pattern. (M)
11. **Health/readiness** — add `/health/ready` that checks Postgres + MinIO reachability (the current `/health` is liveness only). (S)
12. **Distributed rate limiter (only if scaling >1 instance)** — the in-memory limiter is per-instance and resets on restart. If the API is ever horizontally scaled, move buckets to Redis. Note in `lib/rateLimit.ts`. (M, conditional)

## Phase 3 — P2 deferred architecture (each was flagged in earlier passes)
13. **PIN enrollment token** — close the `/auth/set-pin` first-login takeover: admin (or `POST /users`) issues a short-lived one-time enrollment code stored on the user; `set-pin` requires it. Removes "anyone can claim an un-onboarded account." (M; touches onboarding UX — its own brainstorm→spec)
14. **Refresh-token revocation/rotation** — a `sessions`/revocation table; `/auth/refresh` checks it and rotates (issue new refresh, invalidate old); add a logout/kill-session endpoint. Today refresh tokens are valid 7d with no revocation. (M)
15. **Presigned-GET media** — `GET /media/:id/download-url` issues a short-lived signed GET; client loads images via it instead of the public bucket URL. Enables turning MinIO anonymous-download OFF (#7). (M; changes how the client loads images — coordinate with frontend)
16. **httpOnly-cookie auth option (API side)** — support `Set-Cookie: jwt=…; HttpOnly; Secure; SameSite=Strict` on `/auth/token` for the web client (mobile keeps JSON/SecureStore). Pairs with the frontend plan's web-token-storage item. (M)

## Verification
- `tsc --noEmit` (api) clean; `pnpm audit` clean at chosen level.
- Token-harness (extend `sectest.js`): crew INSERT to `inventory_items`/`jobs` via push → 403 once #5 lands (and an `add_inventory` role still succeeds); GET `/sync/full` past the new limit → 429; an unexpected handler error returns generic 500 (no stack); helmet headers present on API responses.
- Deploy API to Unraid (rebuild image → `docker load` + `compose up -d api`), confirm health/ready 200, backups job runs, CI green on a test PR.

## Notes / sequencing
Phase 1 is the highest value-per-effort (mostly S/M, no UX change) — do it first and deploy. Phase 2 is operational maturity. Phase 3 items each warrant their own brief spec (they change onboarding/auth/media-loading). #7↔#11↔#15 are interdependent (do presigned-GET before removing anonymous download).
