---
name: deploy-api
description: Build, ship, and deploy the InventoryPro Fastify API (and the Expo Web app) to production — the VPS VM at 192.168.1.72 behind host nginx (fronted by NPM on Unraid). Use whenever the user wants to deploy/ship/release the API or backend, push a migration to prod, update the web app, or "get the changes live" on api.invenpro.app / invenpro.app. Migrations run automatically on API boot, so shipping also applies them — treat every API deploy as a schema change.
---

# Deploy InventoryPro — API + Web (VPS prod)

Production moved off Unraid on **2026-07-21**. It now runs on a VPS VM
(`pmshydra@192.168.1.72`, an Unraid-hosted bridged VM) installed by
`infra/vps/install.sh`: Postgres + MinIO + API + Web from
`infra/docker-compose.prod.yml` + `/opt/inventorypro/compose.vps.yml` (all
container ports loopback-bound), host nginx as the edge with a Let's Encrypt
multi-SAN cert. Public chain: client → NPM on Unraid (hosts 7/8/10) →
`https://192.168.1.72:443` (VPS nginx) → containers.
**Migrations run automatically on API startup** (`runMigrations()` in
`apps/api/src/index.ts`), so deploying is also how migrations reach prod.

- **Access:** `ssh pmshydra@192.168.1.72` is passwordless, but **sudo needs the
  user's password** — Claude preps everything; the user runs the one privileged
  command via `ssh -t`. Never try to sudo non-interactively.
- **Layout on the VM:** app checkout `/opt/inventorypro/app`, env
  `/opt/inventorypro/.env` (secrets — never print), helpers
  `/opt/inventorypro/bin/{upgrade,status,add-wg-client,finalize-lockdown}.sh`,
  compose = `docker compose --project-name inventorypro --env-file /opt/inventorypro/.env -f /opt/inventorypro/app/infra/docker-compose.prod.yml -f /opt/inventorypro/compose.vps.yml`.
- **The deploy mechanism is git-pull-and-build on the VM**, not image tarballs:
  `upgrade.sh` does `git pull --ff-only` of the configured branch (**main**),
  rebuilds the api/web images, recreates, and health-gates.

## Pre-flight (do BEFORE deploying — these have bitten us)
- **Lockfile in sync** (Docker build uses `--frozen-lockfile`):
  `pnpm install --frozen-lockfile --filter api...` must say "Lockfile is up to date".
- **`@fastify/helmet` v13+** (Fastify v5 since #93; helmet v11 breaks).
- **`media.ts` fails closed on MinIO creds** — API throws at boot if
  `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` unset; prod compose maps them from
  `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`.
- **`TRUST_PROXY`** must name EVERY proxy hop or `request.ip`/audit-IP/rate-limits
  break. On the VPS that means the docker bridge range AND `192.168.1.239` (NPM,
  host-network on Unraid) — plus Cloudflare ranges if the domains are ever
  orange-clouded. The installer wrote only `172.16.0.0/12`; check before blaming code.
- Typecheck + tests green: `cd apps/api && npx tsc --noEmit && npm test`.

## A. Deploy (API and/or Web — same path)
1. **Commit on a feature branch, PR, merge to `main`, push** — prod pulls `main`,
   so nothing deploys until the change is on `origin/main`. Never commit straight
   to `main`; end commit messages with the `Co-Authored-By: Claude …` trailer.
2. **User runs the upgrade** (needs sudo — give them exactly this):
   ```bash
   ssh -t pmshydra@192.168.1.72 sudo /opt/inventorypro/bin/upgrade.sh
   ```
   It pulls, rebuilds both images, recreates, and waits for `/health`. Web's
   `EXPO_PUBLIC_API_URL` is baked at build time from the env file, so web changes
   ship the same way.
3. **Claude verifies from outside** (no sudo needed):
   ```bash
   curl -s https://api.invenpro.app/health     # {"ok":true,...} — uptime should be small
   curl -s -o /dev/null -w '%{http_code}\n' https://invenpro.app/
   ```
   Schema version needs a privileged psql — user-run:
   ```bash
   ssh -t pmshydra@192.168.1.72 "sudo docker exec inventorypro-postgres-1 psql -U inventorypro -d inventorypro -tAc 'SELECT max(version) FROM schema_migrations;'"
   ```

## After an auth/migration change
- **New synced column:** reaches devices only after the mobile app rebuild
  (`deploy-android`); pull.ts parity must already be in place.
- **Enrollment / PIN changes:** users created pre-migration with `pin_set=false`
  and `enrollment_code_hash IS NULL` are locked out of `/auth/set-pin` — issue
  codes via admin Reset PIN.
- **Client-breaking API change:** ship APK + Web too; old clients 4xx until updated.

## Ops notes
- `status.sh` (via sudo) gives a stack overview; health timer logs to
  `/var/log/inventorypro-health.log` on the VM.
- MinIO console: `https://minio.invenpro.app` — **WireGuard-only** (DNS →
  10.8.0.1; connect the WG tunnel first).
- Postgres is loopback/container-only — reach it via the sudo docker-exec psql above.
- Deploying is outward-facing: confirm with the user before shipping unless
  they've said go.

## Legacy / rollback (Unraid)
The old Unraid stack (`root@192.168.1.239`, `/mnt/user/appdata/inventorypro`) is
**stopped, kept as rollback** — do not start it alongside the VPS (same domains,
forked data). Full rollback = start those containers AND restore NPM
(`NPM.db.pre-vps-cutover`, `proxy_host/{7,8,10}.conf.bak`, `nginx -s reload`).
NPM gotcha: restarting its container does NOT regenerate confs from the DB.
The old tarball-ship runbook lives in git history and `infra/DEPLOY-COMMANDS.md`.
