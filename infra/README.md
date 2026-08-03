# Blue-green API deploys (#247)

Blue-green is the **default** upgrade path for the VPS install (`infra/vps/install.sh`) —
there is no flag to opt out, and no separate "blue-green mode" script. This doc explains
how it works, how to retrofit it onto a VPS that was installed before #247, and the known
gaps it introduces. It does not apply to the Unraid/self-host path (`DEPLOY-UNRAID.md`,
`DEPLOY-SELFHOST.md`) — see "Why the self-host path is unaffected" below.

## How it works

Two identical API containers ("colors") run at all times as warm standbys of each other:

| Color | Compose service | Loopback port |
|---|---|---|
| blue  | `api`  | `127.0.0.1:3000` |
| green | `api2` | `127.0.0.1:3001` |

Exactly one is "active" (serving real traffic through nginx) at any moment. The active
color is a single line in `/etc/nginx/inventorypro-api-active.conf`:

```nginx
set $api_upstream inventorypro_api_blue;
```

`inventorypro_api_blue`/`inventorypro_api_green` are nginx `upstream` blocks (in
`/etc/nginx/conf.d/inventorypro-api-upstreams.conf`, pointing at ports 3000/3001) — the api
vhost's `location /` does `proxy_pass http://$api_upstream;`, so which upstream it uses is
entirely determined by that one included file. This file is the single source of truth for
"which color is live" — `/opt/inventorypro/bin/upgrade.sh` and `status.sh` both read it
directly rather than keeping a separate state file that could drift.

`/opt/inventorypro/bin/upgrade.sh`'s flow on every run:

1. `git pull`, then the existing #208 pre-upgrade `pg_dump` (unchanged).
2. Read the active color from `inventorypro-api-active.conf`; the OTHER color is the
   standby for this deploy.
3. Build + `up -d` **only the standby color** (plus `web`, which has no color of its own).
   The active color's container is never touched at this point — it keeps serving.
4. Health-gate the standby on its **own loopback port** (`curl 127.0.0.1:<standby-port>/health`,
   up to 5 minutes, same cadence #214 used). Migrations run automatically on the standby's
   boot (#238's advisory lock makes this safe even with the active color's old code still
   running against the now-migrated schema for a short window — see "Known gaps" below).
   - **Gate fails** → nginx is never touched, the active color is never stopped. There is
     nothing to roll back on the API side because nothing live was ever changed. (`web`
     still gets #214's old retag-and-restore treatment, since it has no standby of its own.)
   - **Gate passes** → flip: rewrite the one-line active-color file to the standby's color,
     `nginx -t && nginx -s reload` (reload doesn't drop in-flight connections — it only
     routes *new* ones to the new upstream, so the flip itself is near-zero-downtime).
5. Post-flip smoke test through the real public path (`curl --resolve <api-domain>:443:127.0.0.1
   https://<api-domain>/health`, exercising the actual cert + SNI + Host routing, not just the
   loopback port again). If THIS fails, flip back to the previous color immediately and exit —
   the old container was never stopped, so this is a clean revert with no capacity loss.
6. On full success: drain 10s, `docker compose stop` the now-old color (**stopped, not
   removed** — it's next deploy's standby), `docker image prune`.

`bin/status.sh` prints which color is active/standby up top. The health-monitor timer
(`inventorypro-healthcheck.sh`) checks whichever port is actually active, not a hardcoded
one — otherwise the very first flip to green would make it false-alarm on the now-stopped
blue container forever.

## Retrofit runbook — existing VPS (run this afternoon)

This applies to a VPS that was installed **before** #247 (i.e. `install.sh` has already run
successfully and the box is serving traffic from a single `api` container). Run everything
below as root on the VPS.

1. **Pull the code that has the api2 service + the new install.sh.**
   ```bash
   cd /opt/inventorypro/app
   git pull --ff-only
   ```
   This updates `infra/docker-compose.prod.yml` (now has the `api2` service, inert until a
   profile activates it) and `infra/vps/install.sh` (now has the blue-green nginx/upgrade
   logic) in this app checkout — steps 5 below re-run install.sh straight out of it.

2. **Manually edit `/opt/inventorypro/.env`** — append one line to activate the (already
   profile-gated) `api2` service:
   ```bash
   echo 'COMPOSE_PROFILES=blue-green' >> /opt/inventorypro/.env
   ```

3. **Manually edit `/opt/inventorypro/compose.vps.yml`** — add the loopback bind for `api2`
   (mirrors the existing `api`/`web`/`minio` overrides already in that file):
   ```yaml
     api2:
       ports: !override
         - "127.0.0.1:3001:3000"
   ```
   (Open the file, add this under the existing `services:` key, alongside the `api:` block.)

4. **Bring up the standby color** — it shares the exact same image as `api` (both reference
   `${API_IMAGE:-inventorypro-api:latest}`), so no build is needed the first time:
   ```bash
   COMPOSE="docker compose --project-name inventorypro --env-file /opt/inventorypro/.env -f /opt/inventorypro/app/infra/docker-compose.prod.yml -f /opt/inventorypro/compose.vps.yml"
   $COMPOSE up -d api2
   curl -fsS http://127.0.0.1:3001/health   # expect {"ok":true,...}
   ```

5. **Regenerate the nginx vhost + upstreams, and the day-2 helper scripts**, from the
   pulled `install.sh` (it resumes from saved answers — no new questions asked):
   ```bash
   bash /opt/inventorypro/app/infra/vps/install.sh --redo nginx
   bash /opt/inventorypro/app/infra/vps/install.sh --redo helpers
   bash /opt/inventorypro/app/infra/vps/install.sh
   ```
   The `--redo` calls only clear the phase's done-marker (they don't run anything by
   themselves — see `install.sh --help`); the plain run afterward re-executes just those two
   phases in order (nginx, then helpers), skipping everything else since it's already done.
   `phase_nginx` seeds `/etc/nginx/inventorypro-api-active.conf` to **blue** on this first
   run (since the file doesn't exist yet) — correct, because `api` (blue) is what's actually
   been serving traffic all along. `phase_helpers` overwrites `bin/upgrade.sh`/`status.sh`
   with the blue-green-aware versions.

6. **Verify:**
   ```bash
   /opt/inventorypro/bin/status.sh
   # should print: active: blue (api, :3000)  — standby: green (api2, :3001)
   curl https://api.<your-domain>/health   # still serving, unaffected by any of the above
   ```

From here on, `/opt/inventorypro/bin/upgrade.sh` performs a blue-green flip on every run —
no further setup needed.

## Why the self-host path is unaffected

`infra/docker-compose.prod.yml` is shared between the VPS installer and the Unraid/self-host
docs (`DEPLOY-COMMANDS.md`, `DEPLOY-UNRAID.md`, `DEPLOY-SELFHOST.md`), so `api2` had to be
added there without changing that path's behavior. It's gated behind a compose profile
(`profiles: ["blue-green"]`) — `docker compose -f docker-compose.prod.yml up -d` with no
`--profile` flag and no `COMPOSE_PROFILES` in `.env` (the self-host `.env.prod.example`
template deliberately doesn't set it) never creates `api2` at all. Only the VPS installer's
generated `.env` sets `COMPOSE_PROFILES=blue-green`, so only VPS installs get the second
color.

## Known gaps

- **Per-process rate-limit / login-attempt state doubles up during the overlap window.**
  `apps/api/src/lib/rateLimit.ts`'s `buckets` map and `apps/api/src/routes/auth.ts`'s
  `attempts` map are in-memory, per-container — they were sized/reasoned about assuming a
  single API process. With two colors briefly serving simultaneously (from "standby comes
  up" through "old color is stopped" a few seconds after the flip), a client whose requests
  get routed to both colors effectively sees close to double the intended quota for that
  window, and a login lockout recorded against one color's `attempts` map isn't visible to
  the other. Severity is low: the limits are already generous (not tight UX friction), the
  overlap is short (health gate + drain, not the whole deploy), and nothing about this is
  exploitable beyond "slightly more attempts than intended for a few seconds" — but it's a
  real behavior change from the single-process assumption those modules' comments state, so
  it's documented here rather than silently accepted. No fix is in scope for #247; a future
  fix would mean moving that state into Postgres/Redis, which is a much bigger change.
- **Migration authoring must stay expand/contract-compatible while blue-green is the default
  path.** See the new section in `docs/SYNC-MIGRATION-CHECKLIST.md` — the short version: the
  standby color runs the new migrations and serves the new schema *before* the old color is
  stopped, so a migration that removes/renames something the OLD code still reads or writes
  will break the active (old) color mid-flip. Split destructive/renaming changes across two
  separate deploys (expand in one, contract in a later one), the same discipline any rolling
  deploy needs.
- **Two API containers is now a permanent steady-state resource cost**, not just a
  deploy-time one — both colors stay warm between deploys so a flip never has to boot one
  from cold (that would reintroduce the exact downtime blue-green exists to remove). Size the
  VPS accordingly.
