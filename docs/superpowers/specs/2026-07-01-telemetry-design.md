# Spec — App-wide behavioral telemetry (first-party pipeline)

## Context
We want to know what users actually do in InventoryPro and where they struggle —
usage (A), errors/friction (B), and a fuller audit blend (C) — in both dev and
prod. "Log everything" is scoped to **every screen view + every labeled control
tap + every error/friction event** (not raw click-with-content, which is noisy,
heavy on an offline-first app, and a privacy risk). Chosen approach: a **first-party
telemetry pipeline** we own end-to-end (self-hosted, offline-native, privacy-
controlled) — not PostHog/Sentry/Cloudflare — because it fits the offline-first
architecture and the security posture from the 2026-06-30/07-01 hardening.

## Core architectural line
Telemetry is **completely separate from the business sync outbox.** Telemetry loss
is acceptable; inventory loss is not. Telemetry uses its own local buffer + its own
fire-and-forget endpoint, and is **never** pulled back to devices. The authoritative
business **audit stays in `activity_log`** (reliable, synced); `telemetry_events` is
the lossy behavioral/error layer.

## What is captured
- **screen** — screen views via an expo-router navigation listener (screen name +
  time-on-previous-screen). Web included.
- **action** — a thin instrumented press wrapper + web click delegation that logs
  *which control* was tapped, identified by `testID`/accessibility label + screen.
  **Never** raw text/field contents. Existing `appendLog` business call sites
  (checkout/checkin/quick-add/pin) emit a parallel telemetry `audit` event so we
  don't double-instrument.
- **error** — a global React error boundary, an unhandled-promise handler, sync/
  outbox failures (the "stuck outbox" mode), rejected server actions (403/409), and
  a slow-operation marker (op > threshold).
- Every event carries: `type`, `name`, `screen`, safe `props`, and session/device
  context (below).

Batching + a per-name **rate cap / sampling** so a hot screen can't flood the pipe.

## Data model (NOT synced — bypasses the sync system)
- **Server (API migration 029, server-only):** `telemetry_events` —
  `id UUID PK, session_id TEXT, user_id UUID NULL, device_id TEXT, platform TEXT,
  app_version TEXT, type TEXT, name TEXT, screen TEXT, props JSONB, client_ts
  TIMESTAMPTZ, received_at TIMESTAMPTZ DEFAULT NOW()`. Indexes on
  `(received_at)`, `(type, name)`, `(user_id)`. **Not** in `ALLOWED_TABLES`/
  `FULL_TABLES`/`pull.ts` — it never syncs to devices, so no sync-migration-checklist
  parity applies.
- **Client (mobile migration 024, local-only):** `telemetry_buffer` — a small
  **ring buffer** (cap ~2000 rows, oldest-dropped) holding unsent events so the UI
  never blocks and offline events survive a restart. Local-only; never in the sync
  outbox.

## Transport
- New module `apps/mobile/src/telemetry/` : `track(event)` (enqueue into
  `telemetry_buffer`, non-blocking), `flush()` (batch send), a screen/press/error
  capture layer, and session/device/version context.
- `flush()` sends a batch to a **new `POST /telemetry`** (`apps/api/src/routes/
  telemetry.ts`): authenticated (JWT `sub` → `user_id`; anon `session_id` before
  login), **fire-and-forget** (client drops the batch from the buffer on 2xx; on
  failure it retries a bounded number of times then drops — telemetry loss is OK),
  **body-size-capped** (`maxItems` on the batch) and **rate-limited**, payload
  schema-validated. Flush triggers: ~20 buffered events, ~30s timer, or app
  backgrounding. Hooked off the existing sync `engine.ts` cadence where convenient,
  but on its OWN request (not the sync push).

## Privacy, security, retention
- **Never captured:** PINs, raw field values, PII. `props` is an **allowlist** of
  safe keys (ids, counts, durations, error codes, boolean flags) — names not content.
- Attributed via JWT `sub` (same as `activity_log`); `session_id` is a random
  per-launch id used before login / for anon grouping.
- `/telemetry`: authenticated, rate-limited, body-size-capped, schema-validated —
  same discipline as the hardening. Not a new PII sink.
- **Retention:** a prune (mirroring the `processed_outbox` prune in `db/migrate.ts`)
  drops `telemetry_events` older than **90 days** so the table can't grow unbounded.

## Dev vs prod & kill-switch
- **Dev (`__DEV__`):** events also `console.log` (tagged `[telemetry]`); optional
  on-screen debug feed. **Prod:** batched to the server only, no console.
- **Kill-switch:** `app_config.telemetry_enabled` (remote, no rebuild) gates both
  capture and flush; `EXPO_PUBLIC_TELEMETRY` sets the build default. Off = no capture.

## Dashboards
- **v1:** a few SQL views / queries (top screens, drop-off, error rate by screen,
  per-user activity) documented in the repo.
- **Follow-on (not v1):** self-hosted **Metabase** on Unraid pointed read-only at
  `telemetry_events` for no-code dashboards/funnels. v1 is not blocked on it.

## Files
- Server: `apps/api/src/db/migrations/029_telemetry_events.sql` (new),
  `apps/api/src/routes/telemetry.ts` (new, registered in `index.ts`), prune in
  `apps/api/src/db/migrate.ts`.
- Mobile: `apps/mobile/src/db/migrations/024_telemetry_buffer.ts` (new; register
  m024 in `schema.ts` + `schema.web.ts`), `apps/mobile/src/telemetry/*` (tracker,
  capture, transport), a `<TelemetryBoundary>` wrapping the app root, an
  instrumented `TrackablePressable`/press wrapper, expo-router nav listener, and
  hooks into `sync/engine.ts` (flush cadence) + `sync/outbox.ts` (failure events).

## Verification
- `tsc --noEmit` clean (api + mobile); `npm test` (api) green + unit tests for the
  props-allowlist redactor and the ring-buffer cap logic.
- Deploy API (migration 029) — confirm `telemetry_events` exists; `POST /telemetry`
  accepts a batch (authed) and rejects oversized/unauth.
- On device: navigate a few screens, tap controls, force an error, go offline→online
  — confirm events buffer offline and flush in a batch; confirm PINs/field values
  never appear in `props`; confirm the `telemetry_enabled=false` kill-switch stops it.

## Out of scope (v1)
Metabase deploy (follow-on); session replay; heatmaps; raw click-with-content
capture; funnels UI in-app; per-event user consent (internal company devices).
