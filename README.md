# InventoryPro

Offline-first inventory, job and fleet management for a field-service crew.
One codebase ships three surfaces:

- **Android app** (Expo / React Native) — the primary tool. Works fully
  offline against a local SQLite database and syncs when it has signal.
- **Web app** (Expo Web) — same UI in the browser, backed by sql.js.
- **API server** (Fastify + Postgres + MinIO) — the sync hub, auth
  authority, media store and push-notification relay.

Every device keeps a complete local copy of the data. Writes go to local
SQLite first, queue in an **outbox**, and push to the server when online;
pulls are incremental by watermark. Conflicts resolve server-side with
per-table policies, and the server enforces role permissions on every push.

```
┌────────────┐   push/pull    ┌─────────────────────────────┐
│ Android    │◄──────────────►│  VPS                        │
│ (SQLite +  │                │  nginx (TLS edge)           │
│  outbox)   │   media up/    │   ├─ Fastify API ─ Postgres │
├────────────┤   downloads    │   ├─ Expo Web (static)      │
│ Browser    │◄──────────────►│   └─ MinIO (S3 media)       │
│ (sql.js)   │                │  WireGuard (management)     │
└────────────┘                └─────────────────────────────┘
```

## Repo layout

| Path | What |
|---|---|
| `apps/mobile` | Expo SDK 56 app (Android + web from the same source) |
| `apps/api` | Fastify 5 API — raw SQL on `pg`, no ORM |
| `infra/` | Docker compose files (dev, prod, all-in-one) + nginx configs |
| `infra/vps/` | One-file production VPS installer + backup setup |
| `docs/` | Operator + developer docs (see [Docs index](#docs-index)) |

---

## Step 0 — prerequisites (dev machine)

A Linux dev box (any distro; commands below are Debian/Ubuntu-flavored —
substitute your package manager) with:

- **Node 20** (repo is on v20; use [nvm](https://github.com/nvm-sh/nvm) or your distro's package)
- **pnpm 9** — `corepack enable` (bundled with Node) or `npm i -g pnpm@9`.
  This is a pnpm workspace; **npm/yarn will not work**.
- **Docker + compose plugin** — for local Postgres/MinIO
- For the Android app: **JDK 17**, **Android SDK** (Android Studio or
  command-line tools), `adb`, and a physical device with USB debugging.
  Gradle is pinned at 8.13 via the wrapper — don't upgrade it.

```bash
git clone https://github.com/TDHydra/inventorypro.git
cd inventorypro
pnpm install
```

## Step 1 — backing services (Postgres + MinIO)

```bash
cp apps/api/.env.example apps/api/.env   # then edit the CHANGE_ME values
pnpm infra:up                            # postgres:16 + minio + bucket init
```

`MINIO_PUBLIC_ENDPOINT` / `PUBLIC_MEDIA_URL` must be an address **phones can
reach** (your machine's LAN IP, not `localhost`) or media uploads from a
device will fail.

## Step 2 — API

```bash
pnpm db:migrate     # also runs automatically on API boot
pnpm dev:api        # tsx watch, http://localhost:3000  (health: /health)
```

## Step 3 — the Android app

First time (or after any native/module change) build the **dev client**
onto your USB-connected phone:

```bash
cd apps/mobile
npx expo run:android          # debug build, installs + launches
```

Day-to-day you only run Metro and hot-reload JS into that client:

```bash
npx expo start --clear        # Metro on :8081
adb reverse tcp:8081 tcp:8081 # phone reaches Metro over USB — re-run after
                              # every unplug/reboot; forgetting this is the
                              # #1 cause of "failed to load bundle"
adb reverse tcp:3000 tcp:3000 # phone reaches the local API the same way
```

Point the app at your API with `EXPO_PUBLIC_API_URL` (defaults are wired
through `app.config.js`; for USB dev, `http://localhost:3000` works thanks
to the adb reverse).

## Step 4 — the web app

```bash
cd apps/mobile
npx expo start --web
```

Web uses a sql.js (WASM) SQLite shim instead of the native driver. If you
get a blank screen on a fresh web build, the staged WASM file is the usual
suspect — it must be `sql-wasm-browser.wasm` (see
`docs/archive/` web build notes).

## Tests

```bash
cd apps/mobile && pnpm exec tsc --noEmit && pnpm test   # typecheck + unit
cd apps/api   && pnpm test
```

CI expectation: both suites green before any merge to `main`.

---

## Production — one-command VPS install

`infra/vps/install.sh` turns a **fresh** VPS into the full production
stack, idempotently (re-running resumes at the failed phase):

- Docker stack (Postgres, MinIO, API, Web) bound to loopback only
- Host nginx as the TLS edge; Let's Encrypt via Cloudflare DNS-01
- Cloudflare A records created for you (optional)
- WireGuard management tunnel — MinIO console and (after lockdown) SSH are
  reachable only through it
- UFW firewall, healthchecks.io monitoring, generated secrets in a
  root-only credentials file
- Day-2 helpers: `upgrade.sh` (deploy latest), `status.sh`,
  `add-wg-client.sh`, `finalize-lockdown.sh`

**You need:** a fresh VPS (2 GB RAM is fine), a domain on **Cloudflare**
(free plan works) with an API token scoped to Zone/DNS/Edit, and 4
subdomains planned (api, app, s3, minio-console).

```bash
scp infra/vps/install.sh root@<vps-ip>:
ssh root@<vps-ip> bash install.sh
```

All questions are asked once, up front; the rest is unattended. The final
summary prints credentials, WireGuard QR codes and a go-live checklist.

**Supported distros:** tested on **Ubuntu 24.04 / 26.04**; **Debian 12 / 13**
supported (same apt toolchain, Docker's Debian repo is selected
automatically). Other apt-based derivatives run after a confirmation
prompt. Non-apt distros (Fedora/RHEL/Alpine): the *stack* is plain Docker
so nothing else is distro-specific — install Docker, nginx, certbot
(+ `dns-cloudflare` plugin), WireGuard and a firewall with your package
manager, then mirror the script's phases by hand (`install.sh --phases`
lists them; each phase function is short and readable).

### Upgrades

```bash
ssh <vps> /opt/inventorypro/bin/upgrade.sh   # git pull, rebuild, restart
```

Migrations run automatically on API boot. **Always deploy the API before
shipping app builds that need new tables/columns** — devices must never
push schema the server doesn't have (`docs/SYNC-MIGRATION-CHECKLIST.md`).

### Backups (automatic, on- and off-site)

```bash
scp infra/vps/setup-backups.sh root@<vps-ip>:
ssh root@<vps-ip> bash setup-backups.sh          # nightly timer + first run
ssh root@<vps-ip> /opt/inventorypro/bin/connect-gdrive.sh   # off-site → Google Drive
```

Nightly (03:30): Postgres `pg_dump` (14 daily dumps kept) + incremental
media mirror, then an `rclone sync` of everything to a Google Drive folder
once an account is connected — `connect-gdrive.sh` walks through the
two-minute token flow and the token can only see the backup folder it
creates. Restore procedures (single table to full-server disaster):
**[docs/BACKUPS.md](docs/BACKUPS.md)**.

---

## Android release builds

Two paths (details + credential runbook in `docs/push-setup.md` and the
`deploy-android` skill):

- **Sideload APK**: local release build signed with the repo keystore —
  installs over Play builds (same key).
- **Play Store**: EAS cloud build (`npx eas-cli build -p android --profile
  production`) with remote auto-incremented versionCode, then
  `npx eas-cli submit -p android --latest`. Store listing assets live in
  `docs/store/`.

Push notifications ride Expo Push over FCM V1; builds need
`google-services.json` (gitignored — wired via `app.config.js` locally, an
EAS file env var in the cloud). Credential state lives in
`docs/push-setup.md`.

## Docs index

| Doc | What |
|---|---|
| `docs/STATUS.md` | Living build log — current state of every feature |
| `docs/SYNC-MIGRATION-CHECKLIST.md` | **Read before adding any synced table/column** |
| `docs/BACKUPS.md` | Backup system + restore procedures |
| `docs/SECURITY-HARDENING.md` | Threat model + hardening applied |
| `docs/push-setup.md` | Push/Play credential state + rotation recipes |
| `docs/telemetry-queries.md` | Useful SQL against the telemetry tables |
| `infra/DEPLOY-SELFHOST.md` | Non-VPS self-hosting (LAN / Unraid / all-in-one image) |

## Troubleshooting the usual hiccups

| Symptom | Fix |
|---|---|
| Phone says "failed to load bundle" | `adb reverse tcp:8081 tcp:8081` (drops on unplug/reboot) |
| Wrong app version loads on phone | Another Metro (sibling checkout/worktree) owns :8081 — kill it, restart yours |
| Web build blank screen | Wrong WASM staged — needs `sql-wasm-browser.wasm` |
| "no column named X" on web after a migration | The migration was registered in `schema.ts` but not `schema.web.ts` — both are required |
| Media upload fails from device | `MINIO_PUBLIC_ENDPOINT` isn't reachable from the phone (use LAN IP) |
| Push works in dev but a table won't sync | API not deployed with the matching migration — API deploys first, always |
