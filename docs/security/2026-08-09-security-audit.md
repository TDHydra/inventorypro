# InventoryPro Security Audit — 2026-08-09

**Scope:** Full stack — API (Fastify + raw `pg`), mobile/web client (Expo RN + Expo Web),
database & migrations, infrastructure, permissions model, and security-relevant UX.
**Method:** Static review + live probing of a throwaway local instance (docker project
`ipaudit`, ports 3900/9900). **Production (`74.91.114.166`) was never touched.**
**Engine:** 80 agents — 12 dimension auditors + 2 prior-audit regression re-verifiers, each
candidate finding adversarially checked by 3 refuters (upstream-guard / exploitability / impact
lenses), surviving only on ≥2-of-3 non-refuted. Plus 2 findings confirmed manually by the lead
(see Calibration notes).

---

## Honest coverage statement

This audit **cannot and does not certify InventoryPro as "completely secure."** No audit can.
What it provides is a systematic, adversarially-verified sweep with reproducible findings.

**Covered:** every `fastify.pg.query` call site; all REST route authz; the `/sync/push`
write-path guard chain; read-scoping/projections; media/upload IDOR; mobile SQLite query
builders; WebView/`dangerouslySetInnerHTML` XSS surfaces; auth/JWT/lockout; device at-rest
secrets; docker/nginx/TLS infra; dependency advisories; and re-verification of all 16 prior-audit
findings.

**Not covered / limitations:** no source-level review of third-party dependencies beyond
advisory metadata; no fuzzing at scale; no timing/side-channel analysis of bcrypt; the mobile
findings are static-only (no rooted-device or MITM lab); load/stress DoS was reasoned about, not
load-tested; MinIO/S3 internals treated as a black box; and the live probes ran against a seeded
dev database, not production data volumes.

---

## Headline result

**The two things you specifically asked about — SQL injection and XSS — are the codebase's
strong points.** Both dedicated SQLi auditors (API and mobile) and the XSS auditor returned
**zero findings**. The API's discipline of binding every value via `$n` placeholders and
allowlisting every dynamic identifier (`ALLOWED_TABLES` + boot-time `loadTableColumns()`
introspection) holds up under live injection probing. The client's SQL is parameterised and its
only HTML sinks (two map WebViews, one static boot script) take numeric-only or hardcoded input.

**The real risk is authorization and data-scoping**, not injection: several REST routes and
`/sync/push` carve-outs let lower-tier users do things the permission model is supposed to
prevent, and several read paths leak data (customer PII, an org signing secret, all employee
records) across boundaries the sync layer otherwise enforces.

**Confirmed: 13 findings — 8 HIGH, 5 MEDIUM** (plus lower/informational items below).

| # | Sev | Finding | Location |
|---|-----|---------|----------|
| H1 | HIGH | PIN-lockout TOCTOU race — concurrent requests bypass brute-force throttle | `apps/api/src/routes/auth.ts:224` |
| H2 | HIGH | Location quick-add carve-out overwrites **any** location row (no `manage_locations`) | `apps/api/src/routes/sync.ts:1171` |
| H3 | HIGH | Any user forges/backdates `activity_log` audit entries | `apps/api/src/routes/sync.ts:352` |
| H4 | HIGH | Global error handler is dead code — raw Postgres errors leak on every 5xx | `apps/api/src/index.ts:269` |
| H5 | HIGH | Full `users` table (email/phone/permission_overrides) synced to every device | `apps/api/src/lib/syncPolicy.ts:521` |
| H6 | HIGH | Org `qr_signing_secret` synced in cleartext to every device via `app_config` | `apps/api/src/lib/syncPolicy.ts:581` |
| H7 | HIGH | Cross-team read via REST: `GET /jobs/:id` + `GET /media/:type/:id` bypass sync team-scoping | `apps/api/src/routes/jobs.ts:59`, `media.ts:210` |
| H8 | HIGH | Default self-host stack publishes MinIO admin console to `0.0.0.0` | `docker-compose.yml:38` |
| M1 | MED | `DELETE /teams/:id/members/:uid` missing tier guard | `apps/api/src/routes/teams.ts:315` |
| M2 | MED | `PATCH /items/:id` soft-delete (`active:false`) skips `delete_inventory` | `apps/api/src/routes/items.ts:190` |
| M3 | MED | `/sync/push` malformed `payload` → uncaught TypeError → whole-batch 500 | `apps/api/src/routes/sync.ts:1099` |
| M4 | MED | Media upload size unbounded when `content_length` omitted; no media-specific throttle | `apps/api/src/routes/media.ts:129` |
| M5 | MED | Bundled `infra/nginx.conf` proxies MinIO console with no access control | `infra/nginx.conf:48` |

---

## HIGH findings

### H1 — PIN-lockout TOCTOU race (`auth.ts:224`)
`isLocked(lockKey)` is a synchronous read of the in-memory `attempts` map, checked *before*
`await fastify.pg.query(...)` (`:228`) and `await bcrypt.compare(...)` (`:262`); `recordFail()`
runs only *after* those awaits (`:264`). A burst of concurrent requests for one `user_id` all
observe `isLocked()==false` and all get a full bcrypt PIN comparison before any increments the
counter — defeating the intended "≈3 guesses then exponential backoff." The same
check-then-await-then-record shape exists in `/auth/set-pin` (`:328-404`), extending the bypass
to the **enrollment-code guess loop used to onboard a brand-new account** (account-takeover
vector).
**Repro (live):** 20 concurrent wrong-PIN POSTs against a fresh account → all 20 returned `401`
(each really bcrypt-compared); only the 21st *sequential* request got `429`. Sequential control
locked correctly on the 4th. `user_id` is trivially obtained from the public `GET /auth/roster`.
**Fix direction:** increment the failure counter *before* the async work (reserve-then-verify),
or serialise per-`lockKey` attempts with an in-flight set; consider a persistent/shared store so
lockout survives restarts and spans containers.

### H2 — Location quick-add overwrites any location (`sync.ts:1171`)
`locations` uses `INSERT ... ON CONFLICT (id) DO UPDATE` (`:634-638`; not in `INSERT_NO_UPSERT`),
so an INSERT with an *existing* id is a full-row overwrite. The `manage_locations` gate is
bypassed for stock-movers via the `crewVehicleInsertAllowed`/`crewShelfInsertAllowed` carve-out
(`:1163-1179`), which checks the *operation* but not that the target id is a **new** row.
**Repro (live):** as tier-1 `construction_crew` (no `manage_locations`), a `/sync/push` INSERT on
`locations` with an existing location id rewrote that row's columns → `200 ok`.
**Fix direction:** the crew carve-out must require the id to not already exist (or restrict to
vehicle/shelf `kind` and reject overwrites of other location types); treat `ON CONFLICT DO
UPDATE` on `locations` as a `manage_locations`-gated operation.

### H3 — Forgeable `activity_log` audit entries (`sync.ts:352`)
The `activity_log` INSERT path pins `user_id` to the caller (good — no actor spoofing) but never
checks the caller's role permits the claimed `action`. `isAllowedActivity()`
(`syncPolicy.ts:490`) only checks `action ∈ ACTIVITY_ACTIONS` — a set that includes privileged
actions (`login`, `user_role_changed`, `user_pin_reset`, `role_permission_changed`). Combined
with client-supplied `id`/`created_at`/geo, any tier can inject **backdated, privileged-looking
audit records**, and the immutable `no_update`/`no_delete` RULEs mean forged entries are
**permanent**. This directly undermines the audit trail the app relies on for accountability.
**Repro (live):** tier-1 crew pushed an `activity_log` row with `action=user_role_changed`,
`created_at=2020-01-01`, and forged geo → accepted and permanent.
**Fix direction:** server-set `created_at`; validate `action` against the caller's actual
permissions; ignore client geo for privileged actions or mark client-supplied fields as
untrusted.

### H4 — Error handler is dead code; raw Postgres errors leak (`index.ts:269`)
`fastify.setErrorHandler(...)` — the handler whose own comment promises "never leak internal
error detail (SQL errors, etc.) on 5xx" — is registered **after** all route plugins (`:236-250`).
In Fastify 5 each route snapshots the active error handler at registration time, so **no business
route ever gets the sanitising handler**; they keep the built-in default that serialises the raw
`Error`.
**Repro (live):** `GET /items/not-a-uuid` →
`500 {"code":"22P02","message":"invalid input syntax for type uuid: \"not-a-uuid\""}` — raw pg
driver detail. Reproduced on `/jobs`, `/locations`, `/teams`, `/users`, `/media/:id/share-link`.
Secondary fallout: the `vreject:` anti-fuzz counter (only incremented inside this handler) never
fires, and validation-reject audit tagging never runs.
**Fix direction:** move `setErrorHandler` **before** route registration (or `register` the routes
inside a plugin scope that inherits it). This also silently restores the fuzzing throttle and
audit tagging. *(Note: this corrects an over-optimistic claim in the scoping pass, which reported
5xx as already sanitised — the intent is there but the ordering makes it inert.)*

### H5 — Full `users` table synced unscoped to every device (`syncPolicy.ts:521`)
`USERS_COLS` is returned unconditionally by `selectColumnsFor('users', ...)` and `users` is in no
scoping set, so every `/sync/pull` and `/sync/full?table=users` returns **every** employee's id,
name, role, email, phone, `expires_at`, and full `permission_overrides` JSON to any authenticated
caller including the lowest tier. (Prior-audit follow-up gap **(e)**, confirmed still open.)
**Repro (live):** tier-1 crew `GET /sync/full?table=users` returned seeded admin PII
(email/phone) and `permission_overrides`.
**Fix direction:** project a minimal column set for non-privileged callers (name/role/id needed
for UI attribution) and gate email/phone/`permission_overrides` behind a `manage_users`-class
permission; the code already has the machinery (`selectColumnsFor`) to do per-permission
projections.

### H6 — `qr_signing_secret` leaks to every device (`syncPolicy.ts:581`)
`selectColumnsFor('app_config')` returns `key, value, updated_at` for **all** `app_config` rows,
with the comment "no secret columns exist today." The premise is wrong: `qr_signing_secret` is
stored as a **row** (`key='qr_signing_secret'`), not a column, so the org-wide QR HMAC signing
secret syncs to every enrolled device and lands in plaintext local SQLite.
**Repro (live):** set `qr_signing_secret='SUPERSECRET_HMAC_abc123'`; tier-1 crew
`GET /sync/full?table=app_config` returned that value verbatim. An attacker with any device can
then forge valid signed QR payloads org-wide.
**Fix direction:** filter secret `key`s out of the `app_config` projection (allowlist the keys
clients legitimately need), and treat any device-readable "secret" as tamper-evidence only, not
forgery-proofing. *(This finding was confirmed manually — see Calibration notes; the workflow's
read-scoping auditor surfaced H5 instead and a dedup bug skipped the seeded control.)*

### H7 — Cross-team reads via REST bypass sync team-scoping (`jobs.ts:59`, `media.ts:210`)
The sync path scopes `jobs` by team (`teamScopeSql`) so a user only pulls jobs for their teams —
but the REST reads don't. `GET /jobs/:id` is `authenticate`-only with no team check, and
`GET /media/:entityType/:entityId` only participant-gates `message` and uploader-gates `pool`;
`job`/`item`/`location`/`repair`/`equipment_unit`/`service_record` media have **no per-entity
authz**. Any authenticated user who knows (or enumerates) an id reads it.
**Repro (live):** tier-1 crew with **zero** team memberships — for a job correctly hidden from
their sync list — `GET /jobs/:id` returned `customer_name="Jane Homeowner"`,
`site_address="42 Private Rd"`, `description="water damage claim #INS-9981"`; and
`GET /media/job/:id` returned 5 media rows including `secret-damage-photo.jpg`.
**Design note:** the refuters correctly observed this is *not* unique to one route — team
compartmentalisation simply isn't enforced on the REST read layer at all, only in sync. Decide
whether team is a **security boundary** (then enforce it on every read path) or a **UX filter**
(then the sync scoping is misleading). Given customer PII + insurance detail, treat as HIGH until
that decision is made and enforced consistently.
**Fix direction:** apply the same team/ownership predicate used in `teamScopeSql`/`mediaScopeSql`
to the REST `GET /jobs/:id`, `GET /jobs`, and `GET /media/:type/:id` handlers.

### H8 — Self-host stack exposes MinIO admin console to `0.0.0.0` (`docker-compose.yml:38`)
The documented one-command self-host (`docker compose up -d`) publishes `MINIO_CONSOLE_PORT`
(9001, the root-credential admin UI/API) with no bind address → `0.0.0.0`. Unlike Postgres (never
published) and unlike the hardened `infra/vps/install.sh`, nothing restricts it.
**Repro (live):** `curl http://localhost:9901/` → `200` (login SPA, unauthenticated);
`/api/v1/login` responds. Anyone who can reach the host and knows/bruteforces the MinIO root
password gets full object-store admin.
**Fix direction:** bind the console to `127.0.0.1:9001` (or drop it from the default compose and
document reaching it via SSH tunnel), matching the Postgres treatment already in the same file.

---

## MEDIUM findings

### M1 — `DELETE /teams/:id/members/:uid` missing tier guard (`teams.ts:315`)
`POST`/`PATCH` member routes call `canActOnTarget(callerRole, memberRole)` (documented
"security-critical"), but `DELETE` only re-checks authority for the self-removal case — it never
fetches the target's role. A tier-2 `manage_teams` holder can remove a `full_admin`/
`franchise_manager` from a team. **Repro (live):** `production_manager` (tier2) `DELETE`'d an
admin member → `200`. **Fix:** add the same `canActOnTarget` guard to the DELETE handler.

### M2 — `PATCH /items/:id` soft-delete skips `delete_inventory` (`items.ts:190`)
The REST allowlist includes `active`, gated only by `edit_inventory`; the sync path explicitly
requires `delete_inventory` to set `active:false` ("deactivating an item requires
delete_inventory"). The REST route is the inconsistent one. **Repro (live):** `production_manager`
(no `delete_inventory`) `PATCH {"active":false}` → `200`. **Fix:** require `delete_inventory` when
`active` transitions to false on the REST path too.

### M3 — Malformed `/sync/push` payload crashes the batch (`sync.ts:1099`)
The route schema validates only `entries: array<object>` — not `payload` shape. Guard clauses
dereference `entry.payload.<field>` (`:975`, `:1099`) before the safety coercions, so
`payload:null` (or string/array) throws an uncaught TypeError → the **whole 100-entry batch**
500s (H4 makes the raw error visible). Any authenticated user can wedge a sync batch. **Repro
(live):** `{"entries":[{"operation":"UPDATE","table_name":"inventory_items","payload":null}]}` →
`500`. **Fix:** validate per-entry `payload` shape in the schema, or guard the derefs with
null-checks and reject the single entry as a conflict rather than throwing.

### M4 — Unbounded media upload size (`media.ts:129`)
`content_length` is optional; when omitted (the current mobile client's normal behaviour) no
`ContentLength` is bound into the presigned PUT, so objects of any size are accepted (25MB cap is
advisory). The prior audit's "no rate limit" is now only *partly* true — the global 120/min
mutation bucket applies, but there's no media-specific throttle. Net: storage-exhaustion DoS.
**Repro (live):** upload-url with `content_length` omitted → PUT of a 60MB file → `200`. **Fix:**
make `content_length` required and always bind `ContentLength`; add a tighter per-user
media-upload bucket. (Prior follow-up gap **(d)**, partially open.)

### M5 — Bundled nginx proxies MinIO console with no auth (`infra/nginx.conf:48`)
The example TLS nginx proxies `/minio-console/` → `minio:9001` with no `allow`/`deny`,
`auth_basic`, or `auth_request`, despite the inline comment "restrict to internal network in
production." Operators who use this file verbatim expose the admin console. `infra/vps/install.sh`
does lock its equivalent down, so this is the packaged-example footgun. **Fix:** add
`allow`/`deny` or `auth_request` to the location block, or remove it from the example.

---

## Lower-severity / informational (not filed as HIGH work)

- **Dependency advisories (INFO→triage):** baseline `pnpm audit --prod` reports **22 advisories
  (19 high / 3 moderate)** across both workspaces. The high count is dominated by transitive
  dev/build-chain packages (Expo CLI → `xcode` → `uuid@7`, `postcss`, etc.). `tar` was already
  pinned `>=7` in root `package.json`; `bcrypt`'s bundled `@mapbox/node-pre-gyp` still pulls a
  vulnerable `tar` at build time. **Action:** review whether any advisory is reachable in the
  **API runtime** (most are build/dev-only) and bump where cheap. Full output archived in the run
  scratchpad.
- **API container runs as root** (`apps/api/Dockerfile`, `infra/Dockerfile.allinone` — no `USER`).
  Verified live (`whoami`→`root`). Refuted as a *standalone* finding (defence-in-depth, not
  directly exploitable) but worth a one-line `USER node` for hardening.
- **Native SQLite unencrypted at rest** — holds `permission_overrides` and (per H6)
  `qr_signing_secret`. The code documents this as an accepted tradeoff (tamper-evidence, not
  forgery-proofing). Refuted as a finding on that basis, but H6 makes the leaked-secret angle
  matter: fixing H6 removes the secret from the device DB.
- **`*.pass` ignored only via local `.git/info/exclude`, not tracked `.gitignore`.** No secret is
  currently tracked (verified), but a fresh clone won't inherit the ignore. **Action:** add
  `*.pass` to the committed `.gitignore`.
- **CORS allows any `http(s)://localhost:<port>` in all environments** — refuted (no
  `credentials:true`, Bearer-token auth, so no cookie/CSRF leverage), but tighten to dev-only if
  convenient.
- **Web HTTPS enforcement** exists only in `session.ts`, not `session.web.ts` — refuted (prod
  `EXPO_PUBLIC_API_URL` is build-pinned to `https://…` in `eas.json`), noted for centralisation.

---

## Prior-audit regression re-verification (2026-07-06 report)

All 16 prior findings were independently re-checked at HEAD (not trusting commit messages).

| Prior finding | Status at HEAD |
|---|---|
| #01 `reset-enrollment-code` tier guard | **Fixed** (`users.ts` `canActOnTarget` present) |
| #02/#06 `conversation_participants` write authz | **Fixed** (`chatPolicy` guard) |
| #03 `/auth/token` attempts-map DoS | **Fixed** (bounded/swept) — but see **H1** (new race in the same area) |
| #04 refresh-as-access token | **Fixed** (`isRefreshToken` enforced) |
| #05 sync users-INSERT tier guard | **Fixed** |
| #07 messages UPDATE sender ownership | **Fixed** |
| #08 `/sync/push` entries unbounded | **Fixed** (cap 100) — but per-entry shape still unvalidated → **M3** |
| #09/#10 web crypto-at-rest / idle-wipe | Threat-model items; unchanged, accepted |
| #11/#13 media entity/URL allowlist | **Fixed** (`KEY_RE`, entity allowlist) |
| #12 enrollment code expiry | **Fixed** (migration 051) |
| #14 MinIO anonymous ListBucket | **Fixed** (GetObject-only policy) |
| #15 JWT/user_id plaintext in IndexedDB | **Fixed** (AES-GCM) |
| #16 assignment-notification spam | **Fixed** (team-gated) |
| **Follow-up (a) qr_signing_secret readable** | **STILL OPEN → H6** |
| **Follow-up (c) unscoped `GET /media`** | **STILL OPEN → H7** |
| **Follow-up (d) unbounded upload** | **Partially open → M4** |
| **Follow-up (e) unscoped `users` sync** | **STILL OPEN → H5** |
| Follow-up (b) activity_log forgery | **STILL OPEN → H3** |

Net: every formally-confirmed prior finding is fixed; **all five follow-up gaps that were never
closed remain open** and are the bulk of this report's HIGH findings.

---

## Calibration notes (why you can trust the verdicts — and where they slipped)

- **Positive control passed:** the verifier correctly reported prior HIGH #01 as *fixed*.
- **Negative-control miss (transparency):** the plan seeded the known-real H6 `app_config` leak
  as a refuter calibration control. A too-broad dedup regex in the workflow matched an unrelated
  device-secrets finding (whose title contains "qr_signing_secret") and **skipped injecting the
  control**, and the read-scoping auditor happened to report the (larger) H5 users leak instead of
  H6. H6 was therefore **confirmed manually with a live probe** rather than by the panel. No other
  finding depended on the control.
- **Refuter over-refutation observed and corrected:** the media/jobs cross-team leak (H7) was
  reproduced *live* by the exploitability lens in **both** auditors that found it, but voted down
  1/3 because the impact/upstream lenses reframed it as "accepted design, not unique to this
  route." That reframing is *factually right* (it's systemic) but the underlying leak is real —
  so it is **promoted to a confirmed HIGH** here, framed as the systemic scoping gap it is. This
  is the exact miscalibration the controls were designed to catch.

## Refuted candidates (recorded so future audits don't re-litigate)

Genuinely refuted (not real / accepted tradeoff / no impact): SQLi in API and mobile (0 found —
parameterisation + identifier allowlisting hold); XSS (0 found — numeric/hardcoded HTML sinks
only); `sharp` CVE (dependency listed but unreferenced in API source); web `session.web.ts` HTTPS
(build-pinned); CORS localhost (no credentialed cookies); root container & unencrypted SQLite
(defence-in-depth / documented tradeoffs); `*.pass` local-ignore (nothing tracked). The
`activity_log` and media/users items that appear "refuted" in the raw run are duplicates of
confirmed H3/H5/H7 under narrower framings.

---

## Reproduction environment

Throwaway `docker compose -p ipaudit` (postgres16 / MinIO / API) on ports 3900/9900, 81
migrations, dev seed, four JWT tiers (`full_admin`/`franchise_manager`/`production_manager`/
`construction_crew`). Baseline controls: API test suite **583/583 pass**; bundle secret scan
**clean**; enforcement sanity (admin 200 / crew 403 / anon 401) confirmed. Every finding marked
"Repro (live)" was executed against this stack. The stack and all credentials were destroyed
after the audit.
