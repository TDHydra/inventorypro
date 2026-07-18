# Security hardening (#31)

What the #31 hardening wave added and where it lives. Companion pieces:
the demo-mode kill switch (#32 S3) and the API audit trail (migration 042,
admin screen `apps/mobile/app/(app)/(admin)/audit-log.tsx`).

## Release minification (R8/ProGuard)

`apps/mobile/app.config.js` enables R8 code shrinking + resource shrinking on
Android release builds via `expo-build-properties`
(`enableProguardInReleaseBuilds` / `enableShrinkResourcesInReleaseBuilds`).
Keep rules are minimal: `expo-modules-core` / `react-native` ship their own
consumer rules; explicit `-keep`s exist only for `com.op.sqlite.**` (no
consumer rules) and `com.facebook.hermes.**` (JNI-reflected). The plugin must
run BEFORE `withReleaseSigning` so the signing injection sees the final
`buildTypes` block.

Deobfuscation: each release build writes
`android/app/build/outputs/mapping/release/mapping.txt`. Archive it per
release — without the matching mapping file, crash stack traces from that
build are unreadable.

## Audit scripts

- `scripts/check-bundle-secrets.sh <app.apk|app.aab> [web-dist-dir]` (or
  `--web-only <web-dist-dir>`) — extracts the JS bundle + dex from the
  artifact and greps it (plus the optional web dist) against a denylist:
  connection strings, AWS/MinIO key shapes, `JWT_SECRET`-ish literals,
  internal LAN IPs/hostnames, PIN/backdoor markers. Non-zero exit on any hit.
- `scripts/security-audit.sh [app.apk|app.aab] [web-dist-dir]` — runs
  `pnpm audit --prod` for `apps/mobile` and `apps/api` (advisories reported,
  combined exit code at the end), then delegates any artifact/dist argument to
  `check-bundle-secrets.sh`. Run against every release artifact before it
  ships.

## Client-side validation (`apps/mobile/src/lib/validation.ts`)

Shared validators for form input: `parseQuantity`, `parseOptionalCount`,
`parsePackSize`, `validateName`, `validateEmail`, `isUuid`, `validateBarcode`.
Conventions:

- Every validator returns a tagged result — `{ ok: true, value }` or
  `{ ok: false, error }` — never a silently-coerced value (the old
  `parseFloat(x) || 0` trap).
- Validate BEFORE the local write. Nothing invalid reaches SQLite or the sync
  outbox; a bad value that syncs is a push-conflict later.
- On reject: show the inline field error and/or a themed alert
  (`src/lib/themedAlert`), and record
  `track('audit', 'validation_reject', { screen, field, rule })`.
  **Never log or track the user-entered value** — field path and rule name
  only. This applies to telemetry, console logs, and audit metadata alike.

## Server-side rejects and limiters (`apps/api`)

- **`validation_reject` audit outcome** — the global error handler
  (`src/index.ts` `setErrorHandler`) flags Fastify schema-validation errors so
  the audit row (`src/lib/audit.ts`) gets outcome `validation_reject` instead
  of a generic `client_error`. It is a boolean flag — the offending body is
  never stored. `validation_reject` rows are always security-classed, and the
  admin audit screen filters/renders them.
- **`injection_attempt` audit outcome** — `/sync/push` is the app's entire
  write surface, so a crafted entry aimed at a non-allowlisted **table**
  (`ALLOWED_TABLES` miss) or carrying a forbidden/unknown **column**
  (`applyWritePolicy` rejects it → typed `ForbiddenColumnsError`) is a
  schema-probing signal, not a client typo. The handler stashes
  `request.auditInjectionAttempt`; `outcomeFor(status, vreject, injection)`
  promotes the row to outcome `injection_attempt` — and that flag **wins over
  the status code**, because a rejected entry strands as a per-entry conflict
  while the request still returns 200. Always security-classed (365-day
  retention). Like `validation_reject`, it is a boolean — the offending payload
  is never stored.
- **vreject storm limiter** — each schema-invalid request increments a
  per-IP `vreject:` bucket (30/min). A `preHandler` peeks the bucket
  (`peekOverLimit` — a peek never consumes quota the error handler owns) and
  429s the IP once it's over: a burst of malformed requests is fuzzing, not
  typos.
- **Labels QR per-IP limit** — `/labels/*` QR PNG renders are excluded from
  the audit trail as noise and cost a signing lookup + PNG encode each, so the
  plugin has its own `labels:` bucket (60/min per IP).
- **Unauthenticated global limiter** — anonymous traffic (no valid JWT) gets
  a per-IP ceiling of 300/min. Authenticated callers are skipped so one office
  NAT never throttles a whole crew; they have their own per-user `mut:`
  buckets.
- **Shared schema shapes** (`src/lib/schemaShapes.ts`) — `UUID_SCHEMA` and
  `EMAIL_SCHEMA` (pattern + length bounds). Use these in route schemas instead
  of `format: 'uuid'` / `format: 'email'`: Fastify's default Ajv has no
  ajv-formats registered, so `format:` validates nothing.

Push-reject wording constraint: any server message that should permanently
drop a client outbox entry must match `/forbidden|cannot|not allowed/i`, or
the client retries it forever.

### Route input-validation coverage (audited 2026-07-18)

All 27 mutating routes (`fastify.post/put/patch/delete`) validate their input
surface — no unvalidated mutation:

- The 24 body-bearing routes attach a Fastify `body` schema.
- The 2 body-less DELETEs (`media DELETE /:id`, `teams DELETE
  /:id/members/:uid`) validate their path **params** (typed, `required`,
  length-bounded) instead.
- `/sync/push` bounds `entries` (array, `maxItems: 100`); each entry is then
  filtered against the table/column allowlists in the handler.

Re-audit with:
`grep -rnE "fastify\.(post|put|patch|delete)" apps/api/src/routes` then confirm
each registration's `schema` carries a `body` (or `params` for a body-less
DELETE).

## Dependency audit (`pnpm audit --prod`, 2026-07-18)

`scripts/security-audit.sh` (no artifact arg) runs `pnpm audit --prod` per
workspace. As of 2026-07-18 it reports **19 prod advisories** in `apps/api`,
all in **transitive** deps pulled by the Fastify 4.x line:

| Package | Installed | Severity | Fixed in | Notes |
|---|---|---|---|---|
| `fast-jwt` | 4.0.5 (via `@fastify/jwt@8`) | **critical** | ≥6.2.4 | See exposure note below |
| `fast-uri` | 2.4.0 (via fastify/ajv) | high | ≥3.1.2 | 3.1.2 also present (deduped elsewhere) |
| `fastify` | 4.29.1 | high/mod/low | ≥5.7.3 | v4→v5 is a **major** migration |
| `tar` | 6.2.1 (via bcrypt→node-pre-gyp) | high | ≥7.5.16 | 6→7 major; transitive build dep |
| `uuid` | 7.0.3 (transitive) / 10.0.0 (direct) | moderate | ≥11.1.1 | |

**Why not patched in this pass:** every fix is entangled with a **major**
upgrade — the critical `fast-jwt` bump requires a newer `@fastify/jwt`, which
requires **Fastify 5** (breaking changes across every route plugin). That is a
migration with real integration + on-device test surface, not a hardening
one-liner, so it is tracked as its own backlog item rather than bundled here.

**`fast-jwt` exposure (mitigating context):** `@fastify/jwt` is registered with
a **symmetric secret only** (HS256; boot refuses a secret `< 32` chars —
`index.ts:110-120`). No asymmetric keys are configured and no `iss`/`aud`
claim-array validation is used, so the algorithm-confusion / claim-bypass class
that the critical `fast-jwt` advisories describe is **not reached** by this
configuration. The upgrade is still the right long-term fix; the practical
exposure today is low. Refresh tokens are additionally rejected as access
tokens via an explicit `type` check (`index.ts:122-125`).

**Bundle secret scan** (`scripts/check-bundle-secrets.sh`) requires a built
artifact (APK/AAB + web dist); run it as part of a release build:
`scripts/security-audit.sh path/to/app-release.apk apps/mobile/dist`.

## Demo-mode kill switch (`app_config.demo_mode`)

Apex-only switch for the public demo accounts (migration 047, default ON):

- `GET /audit/demo-mode` / `PATCH /audit/demo-mode` — read/flip the flag;
  apex (`full_admin`) only, and the PATCH invalidates the shared cache
  (`src/lib/demoMode.ts`) that the `/auth` roster and set-pin checks read.
- OFF hides demo accounts from the public `/auth/roster` and blocks demo
  sign-in/set-pin.
- `/sync/push` rejects any `app_config` entry with `key = 'demo_mode'`
  (`Forbidden: demo_mode cannot be changed via sync`) so the flag can never be
  flipped through the sync path — only via the authenticated PATCH.
- Independently of the flag, demo/test accounts are read-only server-wide: a
  `preHandler` blocks every mutating route for them (DB-resolved `is_test`,
  never the JWT claim).
