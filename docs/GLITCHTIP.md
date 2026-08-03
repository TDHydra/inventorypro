# GlitchTip (self-hosted error tracking, #213)

GlitchTip is set up on the VPS by `infra/vps/setup-glitchtip.sh` (run once,
as root, **after** `install.sh`). It gives InventoryPro a self-hosted,
Sentry-protocol-compatible crash/error backend — the mobile app's
`@sentry/react-native` client (#213) talks to it exactly like it would talk
to SaaS Sentry, just pointed at our own DSN instead. Keeping crash data on
our own VPS (rather than a third-party SaaS) is a deliberate continuation
of the 2026-07-01 telemetry spec's decision to reject SaaS Sentry.

## What it installs

```bash
scp infra/vps/setup-glitchtip.sh root@<vps-ip>:
ssh root@<vps-ip> bash setup-glitchtip.sh
```

- Its own docker compose project, **`inventorypro-glitchtip`**: `web` +
  `worker` (the GlitchTip image, `glitchtip/glitchtip:6`) + a Redis-protocol
  broker/cache (`valkey/valkey:9`) + a **dedicated Postgres**
  (`postgres:16-alpine`, own volume, own generated password) — deliberately
  isolated from the main InventoryPro app's Postgres container and from
  `setup-backups.sh`'s dump/restore lifecycle (see "Backup coverage" below).
- A Cloudflare A record + a **separate** Let's Encrypt certificate
  (`--cert-name inventorypro-glitchtip`) — not a 5th SAN on the main
  `inventorypro` cert, so its renewal (and eventual removal) never touches
  the app's cert.
- A host-nginx vhost on the same TLS edge `install.sh` already runs.
- Secrets (`SECRET_KEY`, the dedicated Postgres password) generated for you
  into `/opt/inventorypro/glitchtip.env` (chmod 600) — nothing sensitive is
  prompted for.

You're asked **one question**: the subdomain (default `errors.invenpro.app`).
Everything else — Cloudflare token/zone, public IP, Let's Encrypt email —
is reused from `/opt/inventorypro/install.conf` (already collected by
`install.sh`) and `/root/.secrets/certbot-cloudflare.ini`. Re-running the
script is safe: the subdomain, secrets, DNS record, cert and nginx vhost
are all reused/overwritten in place, not duplicated.

Before starting the stack, the script checks `free -m` and warns (with a
confirm prompt) if less than 1024MiB is available — GlitchTip's own docs
target 256-512MB for its minimal single-container mode, but this is the
split web+worker shape (two always-on Python processes) plus a *second*
Postgres and Valkey instance layered on top of whatever the main
InventoryPro stack is already using.

## Afternoon steps (do these once the script finishes)

1. Open `https://<your subdomain>` and sign up as the first (and only) user.
2. Create your Organization, then a Project (platform: "React Native" or
   generic "Sentry").
3. Project settings → SDK Setup / Client Keys → copy the **DSN**
   (`https://<key>@<subdomain>/<project-id>`).
4. That DSN is `EXPO_PUBLIC_SENTRY_DSN` for #213's mobile Sentry client —
   paste it into `apps/mobile/eas.json`'s `preview`/`production` env blocks
   and any local release-build env. Leave it unset for Metro/dev builds
   (the client never calls `Sentry.init` without a DSN, so it's fully inert
   in dev).
5. **Recommended**, once your account exists: close registration. Edit
   `/opt/inventorypro/glitchtip.env`, set `ENABLE_USER_REGISTRATION=False`
   and `ENABLE_ORGANIZATION_CREATION=False`, then
   `docker compose --project-name inventorypro-glitchtip --env-file /opt/inventorypro/glitchtip.env -f /opt/inventorypro/compose.glitchtip.yml up -d`.
   This instance has no other access gate — closed registration + being the
   only account *is* the intended security boundary.

## Backup coverage (accepted gap)

GlitchTip's Postgres is a separate container/volume from the main app's —
that's the whole point of "dedicated," so `setup-backups.sh` (which only
ever `pg_dump`s the main app's `$POSTGRES_DB` by name) does **not** cover
it, and this is intentional, not an oversight: GlitchTip stores error
history, not business data, and isolating it from the app DB's
backup/restore/off-site lifecycle was chosen specifically so a GlitchTip
problem (or its removal) can never affect app backups or vice versa. If
you later want GlitchTip's error history backed up too, add a second
`pg_dump` line pointed at the `inventorypro-glitchtip` compose project
(`docker compose --project-name inventorypro-glitchtip ... exec -T postgres
pg_dump -U glitchtip glitchtip`) — not currently automated.

## Removing GlitchTip

Everything it created can be torn down independently of the main stack:

```bash
docker compose --project-name inventorypro-glitchtip \
  --env-file /opt/inventorypro/glitchtip.env \
  -f /opt/inventorypro/compose.glitchtip.yml down -v   # stack + volumes
rm -f /etc/nginx/sites-enabled/inventorypro-glitchtip.conf \
      /etc/nginx/sites-available/inventorypro-glitchtip.conf
systemctl reload nginx
certbot delete --cert-name inventorypro-glitchtip
rm -f /opt/inventorypro/glitchtip.env /opt/inventorypro/glitchtip.conf \
      /opt/inventorypro/compose.glitchtip.yml
# Optional: delete the Cloudflare A record for the subdomain by hand.
```

## Deviations from GlitchTip's own docs

- Upstream's `compose.sample.yml` recommends a single `all_in_one`
  container (web+worker+migrate combined, `postgres:18`,
  `POSTGRES_HOST_AUTH_METHOD: trust`) as the low-resource default. This
  setup deliberately splits `web`/`worker` (per the requirement) and pins
  `postgres:16-alpine` (matching the version already used everywhere else
  in this repo's compose files) with a real generated password instead of
  trust auth.
- GlitchTip has no documented HTTP health-check path, so the `web`
  container's healthcheck is a plain `python3 -c "urllib.request.urlopen(...)"`
  against the app port (Python is always present in the image) rather than
  a dedicated endpoint. `worker` depends on `web` being healthy specifically
  so it never starts before the web container's automatic migration run has
  finished.
