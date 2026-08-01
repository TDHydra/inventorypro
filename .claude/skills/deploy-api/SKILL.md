---
name: deploy-api
description: Build, ship, and deploy the InventoryPro Fastify API (and the Expo Web app) to production — the cloud VPS at 74.91.114.166 (Dallas), managed over WireGuard as root@10.8.0.1. Use whenever the user wants to deploy/ship/release the API or backend, push a migration to prod, update the web app, or "get the changes live" on api.invenpro.app / invenpro.app. Migrations run automatically on API boot, so shipping also applies them — treat every API deploy as a schema change.
---

# Deploy InventoryPro — API + Web (cloud VPS prod)

Production moved to a real cloud VPS on **2026-08-01**: `74.91.114.166`
(Dallas, Ubuntu 24.04, 2 GB RAM + 4 G swapfile we added, 197 G disk, provider
hostname `dallas-octacosa26-3`), installed by `infra/vps/install.sh`.
Stack: Postgres + MinIO + API + Web from `infra/docker-compose.prod.yml` +
`/opt/inventorypro/compose.vps.yml` (all container ports loopback-bound), host
nginx as the TLS edge (Let's Encrypt multi-SAN via Cloudflare DNS-01,
auto-renews). DNS: Cloudflare zone `invenpro.app`, grey-cloud A records
`api`/`@`/`s3` → 74.91.114.166, `minio` → 10.8.0.1 (WG-only by DNS trick).
No NPM, no Unraid in the chain anymore.
**Migrations run automatically on API startup** (`runMigrations()` in
`apps/api/src/index.ts`), so deploying is also how migrations reach prod.

## Access (changed 2026-08-01 — read this first)

- **Public SSH is CLOSED** (finalize-lockdown ran). Management is
  WireGuard-only: `ssh root@10.8.0.1` (key auth, tdpotato's `id_ed25519`;
  we log in as root so **no sudo/password dance at all** — Claude can deploy
  end-to-end without the user).
- **WireGuard**: local interface `invenpro` (`/etc/wireguard/invenpro.conf`,
  split-tunnel 10.8.0.0/24 only). Bring up with
  `sudo wg-quick up invenpro` (local sudo password: `my.pass` in repo root).
  Client configs live at `~/.config/wireguard-invenpro/{laptop,phone}.conf`
  and on the VPS at `/opt/inventorypro/wireguard/`. phone.conf is not yet
  imported on the user's phone.
- **Password files** (repo root, single-line, git-excluded via
  `.git/info/exclude` — NEVER commit or print):
  `my.pass` = local sudo · `vm.pass` = old .72 VM sudo AND the Hostinger
  SMTP password · `vps.pass` = VPS root password (moot now — password auth
  disabled) · `cloudflareapi.pass` = Cloudflare DNS-edit token.
- **Provider SSH throttling**: bursts of connections to the VPS get
  dropped/blackholed for minutes. ALWAYS multiplex:
  `-o ControlMaster=auto -o ControlPath=~/.ssh/cm/%r@%h:%p -o ControlPersist=30m`.
  Over WG this matters less but keep the habit.
- Secrets: `/opt/inventorypro/.env` (NOT shell-sourceable — SMTP_FROM has
  `<>`; grep vars out instead of `source`). Generated credentials copy:
  `/root/inventorypro-credentials.txt`. Installer answers:
  `/opt/inventorypro/install.conf`.

## Layout on the VPS

App checkout `/opt/inventorypro/app` (git clone of `main` from GitHub,
public repo, https), helpers
`/opt/inventorypro/bin/{upgrade,status,add-wg-client,finalize-lockdown}.sh`,
compose = `docker compose --project-name inventorypro --env-file /opt/inventorypro/.env -f /opt/inventorypro/app/infra/docker-compose.prod.yml -f /opt/inventorypro/compose.vps.yml`.
**Deploy mechanism is git-pull-and-build on the VPS**: `upgrade.sh` does
`git pull --ff-only` of `main`, rebuilds api/web images, recreates,
health-gates.

## Pre-flight (do BEFORE deploying — these have bitten us)
- **Lockfile in sync** (Docker build uses `--frozen-lockfile`):
  `pnpm install --frozen-lockfile --filter api...` must say "Lockfile is up to date".
- **`@fastify/helmet` v13+** (Fastify v5 since #93; helmet v11 breaks).
- **`media.ts` fails closed on MinIO creds** — API throws at boot if
  `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` unset; prod compose maps them from
  `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`.
- **`TRUST_PROXY`**: on this VPS the only hop is the docker bridge
  (`172.16.0.0/12`, which the installer wrote). Add Cloudflare ranges ONLY if
  the domains are ever orange-clouded (they are grey-cloud today —
  s3 must STAY grey or uploads hit Cloudflare's body-size cap).
- Typecheck + tests green: `cd apps/api && npx tsc --noEmit && npm test`.
- 2 GB RAM box: the web image build needs the 4 G swapfile (present, in
  fstab). If a build OOMs, check `swapon --show` first.

## A. Deploy (API and/or Web — same path)
1. Change must be on `origin/main` (prod pulls `main`). Never commit straight
   to `main`; end commit messages with the `Co-Authored-By: Claude …` trailer.
2. WG up, then run the upgrade (Claude can do this alone now):
   ```bash
   sudo wg-quick up invenpro   # if not already up
   ssh root@10.8.0.1 /opt/inventorypro/bin/upgrade.sh
   ```
3. Verify from outside (public internet, no WG needed):
   ```bash
   curl -s https://api.invenpro.app/health     # {"ok":true,...} — uptime should be small
   curl -s -o /dev/null -w '%{http_code}\n' https://invenpro.app/
   curl -s -o /dev/null -w '%{http_code}\n' https://s3.invenpro.app/minio/health/live
   ```
   Schema version (via WG, no sudo needed):
   ```bash
   ssh root@10.8.0.1 "docker exec inventorypro-postgres-1 psql -U inventorypro -d inventorypro -tAc 'SELECT max(version) FROM schema_migrations;'"
   ```

## After an auth/migration change
- **New synced column:** reaches devices only after the mobile app rebuild
  (`deploy-android`); pull.ts parity must already be in place.
- **Enrollment / PIN changes:** users created pre-migration with `pin_set=false`
  and `enrollment_code_hash IS NULL` are locked out of `/auth/set-pin` — issue
  codes via admin Reset PIN.
- **Client-breaking API change:** ship APK + Web too; old clients 4xx until updated.

## Ops notes
- `status.sh` on the VPS gives a stack overview; installer health timer pings
  healthchecks.io (`https://hc-ping.com/a70c57a9-51b3-408f-97f9-ac51122423dd`)
  every minute; health log `/var/log/inventorypro-health.log`.
- MinIO console: `https://minio.invenpro.app` — resolves to 10.8.0.1, so
  WireGuard-only by construction.
- Postgres is loopback/container-only — use the docker-exec psql above.
- Locked out of SSH? Provider web console → `ufw allow 22/tcp`.
- MinIO CORS for web uploads is explicit since #188:
  `MINIO_CORS_ORIGIN` (compose default `https://invenpro.app`).
- Deploying is outward-facing: confirm with the user before shipping unless
  they've said go.

## Migration runbook (used for the 2026-08-01 cutover; reusable)
Freeze writes on source → dump → restore → mirror media → flip DNS:
```bash
# dump (source had sudo-only docker; password piped from file, never printed)
ssh <src> 'sudo -S -p "" docker exec <pg> pg_dump -U inventorypro -d inventorypro -Fc' < <pass-file> > prod.dump
# restore on target (as root): stop api, drop/create db, pg_restore, start api
#   (API restart auto-applies any newer migrations)
# media: dockerized mc on the target, old MinIO still public during the flip
mc alias set old https://s3.invenpro.app $OLD_USER $OLD_PASS
mc mirror --overwrite old/inventorypro-media new/inventorypro-media   # idempotent, re-runnable
# DNS flip: rm /opt/inventorypro/.install-state/dns.done && bash install.sh  (re-runs only the dns phase)
```
Installer tricks: pre-seed `/opt/inventorypro/install.conf` + pre-`touch`
`.install-state/dns.done` = fully hands-off install that DOESN'T touch live
DNS until you're ready.

## Legacy / rollback
- **Tier 1 — Unraid VM `.72`** (`pmshydra@192.168.1.72`, sudo password in
  `vm.pass`): full stack STOPPED 2026-08-01 with data frozen at the cutover
  dump. Rollback = `docker start` the four `inventorypro-*` containers and
  repoint Cloudflare A records back to the home IP / NPM chain.
  Do NOT start it alongside the VPS (same domains, forked data).
- **Tier 2 — original Unraid stack** (`root@192.168.1.239`): ancient
  (pre-2026-07-21), keep ignoring; runbook in git history and
  `infra/DEPLOY-COMMANDS.md`.
