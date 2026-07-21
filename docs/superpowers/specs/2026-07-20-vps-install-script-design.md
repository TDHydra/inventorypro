# VPS install script — design (2026-07-20)

One self-contained script, `infra/vps/install.sh`, that turns a fresh Ubuntu
26.04 (or 24.04) VPS into a production InventoryPro host. Approved choices:

- **Edge:** host nginx + certbot with the Cloudflare DNS-01 plugin (no Nginx
  Proxy Manager). One multi-SAN Let's Encrypt cert (`--cert-name inventorypro`)
  for the api / frontend / s3 / minio-console domains; auto-renew via
  `certbot.timer` + a deploy hook that reloads nginx.
- **App delivery:** git clone to `/opt/inventorypro/app`, images built on the
  VPS with the existing `infra/docker-compose.prod.yml` plus a VPS override
  (`compose.vps.yml`) that uses the `!override` tag to rebind every published
  port to `127.0.0.1` — nginx is the only public door.
- **Lockdown:** WireGuard (`wg0`, `10.8.0.0/24`, split-tunnel clients) is the
  management plane. The MinIO console domain's DNS A record points at
  `10.8.0.1`, and its vhost allow-lists the WG subnet. UFW exposes only
  80/443/WG-udp publicly; SSH stays public until the generated
  `finalize-lockdown.sh` confirms a live WG path and closes it.
- **Monitoring:** healthchecks.io. With a project API key the script creates
  six checks (api, web, minio, postgres, disk, tls) via the API; otherwise a
  single manual heartbeat URL or off. A systemd timer runs
  `inventorypro-healthcheck.sh` every minute; failures ping `<url>/fail` with
  the reason in the body.
- **Secrets:** `POSTGRES_PASSWORD`/`MINIO_ROOT_PASSWORD` (32 alnum chars) and
  `JWT_SECRET` (64) generated from `/dev/urandom`; written to
  `/opt/inventorypro/.env` and `/root/inventorypro-credentials.txt`, both 600.
- **Robustness:** all questions asked once up front and persisted to
  `install.conf`; 13 idempotent phases with done-markers (`--phases`,
  `--redo <name>`, `--reset`); `set -Eeuo pipefail` with an ERR trap that says
  which phase died and how to resume; Cloudflare token verified live before
  use; Docker repo falls back to `noble` if the new Ubuntu codename isn't
  published yet; nginx `http2` syntax picked by version.
- **Day-2 helpers** generated into `/opt/inventorypro/bin/`: `upgrade.sh`
  (pull + rebuild + health-gate), `status.sh`, `add-wg-client.sh`,
  `finalize-lockdown.sh`.
