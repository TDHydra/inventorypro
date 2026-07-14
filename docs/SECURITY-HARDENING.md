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
