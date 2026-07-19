---
name: deploy-api
description: Build, ship, and deploy the InventoryPro Fastify API (and the Expo Web app) to the Unraid prod stack behind Nginx Proxy Manager. Use whenever the user wants to deploy/ship/release the API or backend, push a migration to prod, update the web app, or "get the changes live" on api.invenpro.app / invenpro.app. Migrations run automatically on API boot, so shipping the image also applies them — treat every API deploy as a schema change.
---

# Deploy InventoryPro — API + Web (Unraid prod)

Build locally (Docker 20+), ship a saved image tarball to Unraid, load + recreate the container. **Migrations run automatically on API startup** (`runMigrations()` in `apps/api/src/index.ts` before `listen`), so deploying the image is also how migrations reach prod.

- **Unraid:** `root@192.168.1.239`, appdata `/mnt/user/appdata/inventorypro`. Runbook: `infra/DEPLOY-COMMANDS.md`.
- **Containers:** `inventorypro-api-1`, `inventorypro-postgres-1` (user+db = `inventorypro`), `inventorypro-minio-1`, `inventorypro-web` (**standalone** — see Web below).
- **Edge:** NPM → `api.invenpro.app` (host `API_PORT`, default 3100), `invenpro.app` (8088), `s3.invenpro.app` (9000).
- Prod `.env` lives at `/mnt/user/appdata/inventorypro/.env` (secrets — never commit/print values).

## Git — deploy from a committed, pushed state (do this, don't ship dirty)
Prod builds from the working tree, so an uncommitted deploy corresponds to *no* commit — always commit first so prod == a known SHA.
- **Commit the intended changes.** If on the default branch (`main`), branch first (`git switch -c <feature>`); never commit straight to `main`. End commit messages with the `Co-Authored-By: Claude …` trailer per repo convention.
- **Push to GitHub** (`origin` = `git@github.com:TDHydra/inventorypro.git`): `git push -u origin <branch>`. Do the push as the **final step after the deploy verifies healthy** (so you're not backing up a build that failed), or up-front if you prefer CI to see it first — either is fine, but the deployed image and the pushed SHA must match.
- Offer to open/refresh a PR: `gh pr create` / it updates automatically on push if one exists.
- Only commit/push when the user has asked (this skill's invocation counts); confirm the branch + that the diff is what they expect before pushing outward.

## Pre-flight (do BEFORE building — these have bitten us)
- **Lockfile in sync** (the Docker build uses `--frozen-lockfile`): `pnpm install --frozen-lockfile --filter api...` must say *"Lockfile is up to date"*. If you added a dep, `pnpm --filter api add <x>` first.
- **`@fastify/helmet` must be v13+** (Fastify is v5 as of #93; helmet v11 targets Fastify v4 and breaks). Check `apps/api/package.json`.
- **`media.ts` fails closed on MinIO creds** — the API throws at boot if `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` are unset. The prod compose maps them from `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`; confirm the compose on the box still has that mapping (`grep MINIO_ACCESS_KEY docker-compose.prod.yml`).
- **`TRUST_PROXY`** is a comma-separated list and must name EVERY proxy hop or `request.ip`/audit-IP/rate-limit break: the bridge subnet AND the unraid host IP (NPM runs in host network mode, so it arrives as `192.168.1.239`) AND all Cloudflare ranges (`invenpro.app` is orange-clouded; ranges from cloudflare.com/ips — re-pin if CF publishes changes). Set 2026-07-09; do NOT "simplify" it back to just `172.18.0.0/16` — that regresses every audit row to the proxy IP.
- Typecheck + tests green: `cd apps/api && npx tsc --noEmit && npm test`.

## A. Deploy the API
```bash
cd ~/inventorypro
# 1. Build (context = repo root; Dockerfile handles the pnpm workspace)
docker build -f apps/api/Dockerfile -t inventorypro-api:latest .
# 2. Save + ship
docker save inventorypro-api:latest | gzip > inventorypro-api.tar.gz
scp inventorypro-api.tar.gz root@192.168.1.239:/mnt/user/appdata/inventorypro/
# 3. Load + recreate ONLY the api (leave postgres/minio running)
ssh root@192.168.1.239 'cd /mnt/user/appdata/inventorypro \
  && docker load -i inventorypro-api.tar.gz \
  && docker compose -f docker-compose.prod.yml up -d --force-recreate --no-deps api \
  && sleep 6 && docker compose -f docker-compose.prod.yml logs --tail=25 api'
```
The logs should show `Applying migration NNN…` → `✓ Migration NNN applied` → `Server listening at http://0.0.0.0:3000`. The AWS-SDK node-version warning is harmless.

## Verify
```bash
curl -s https://api.invenpro.app/health            # {"ok":true,...}
# schema version + a new column landed:
ssh root@192.168.1.239 "docker exec inventorypro-postgres-1 psql -U inventorypro -d inventorypro -tAc \
  \"SELECT max(version) FROM schema_migrations;\""
```

## After an auth/migration change
- **New synced column:** it only reaches devices once the mobile app is rebuilt too (`deploy-android`) — the pull.ts parity must already be in place (see the `debug` / sync-migration checklist).
- **Enrollment / PIN changes:** users created before the migration with `pin_set=false` and `enrollment_code_hash IS NULL` are locked out of `/auth/set-pin`. Issue codes (admin **Reset PIN** on each, or a one-off `UPDATE users SET enrollment_code_hash=<bcrypt> …`) and hand the plaintext to the owner.
- **Client-breaking API change:** rebuild + ship the APK (`deploy-android`) and Web (below); old clients may 4xx until updated.

## B. Deploy the Web app (standalone container — NOT a compose service)
`inventorypro-web` is a plain `docker run`, so update it with rm+run, not `compose up`.
```bash
cd ~/inventorypro
docker build -f infra/Dockerfile.web --build-arg EXPO_PUBLIC_API_URL=https://api.invenpro.app -t inventorypro-web:latest .
docker save inventorypro-web:latest | gzip > inventorypro-web.tar.gz
scp inventorypro-web.tar.gz root@192.168.1.239:/mnt/user/appdata/inventorypro/
ssh root@192.168.1.239 'cd /mnt/user/appdata/inventorypro && docker load -i inventorypro-web.tar.gz \
  && docker rm -f inventorypro-web \
  && docker run -d --name inventorypro-web --restart unless-stopped -p 8088:80 inventorypro-web:latest'
curl -s -o /dev/null -w "%{http_code}\n" https://invenpro.app/   # 200
```

## C. Push to GitHub (final step)
After the deploy verifies healthy, back up the deployed SHA:
```bash
git push -u origin "$(git branch --show-current)"
gh pr create --fill   # or skip if a PR already tracks the branch (push updates it)
```
Confirm the pushed HEAD matches what you built the image from.

## Notes
- `--no-deps` keeps Postgres/MinIO untouched; their data lives in named volumes and persists across API updates.
- Postgres is **not** host-exposed — reach it only via `docker exec inventorypro-postgres-1 psql -U inventorypro -d inventorypro`.
- Deploying is outward-facing/irreversible-ish: confirm with the user before shipping unless they've said go.
