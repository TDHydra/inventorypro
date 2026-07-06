# Deploying InventoryPro on Unraid behind Nginx Proxy Manager

This stack runs **Postgres + MinIO + the API**. Nginx Proxy Manager (NPM),
which you already run, is the TLS edge and routes your domains to it. There is
no bundled web server — NPM is the front door.

```
                     ┌────────────────── Unraid ──────────────────┐
 Internet ─TLS─► NPM ─┤ api.invenpro.app   → :3000  (API)       │
                     ┤ s3.invenpro.app    → :9000  (MinIO S3)   │
                     ┤ minio.invenpro.app → :9001  (console)    │
                     └  postgres (internal network only) ──────────┘
```

---

## 1. Get the API image onto Unraid

Pick one.

### Quick path — export/import a tarball (no registry)
On this dev machine:
```bash
cd ~/inventorypro
docker build -t inventorypro-api:latest -f apps/api/Dockerfile .
docker save inventorypro-api:latest | gzip > inventorypro-api.tar.gz
# copy the tarball to Unraid (scp/SMB), then on Unraid:
gunzip -c inventorypro-api.tar.gz | docker load
```

### Recommended — push to a registry (GHCR)
```bash
docker build -t ghcr.io/<youruser>/inventorypro-api:latest -f apps/api/Dockerfile .
echo $GHCR_TOKEN | docker login ghcr.io -u <youruser> --password-stdin
docker push ghcr.io/<youruser>/inventorypro-api:latest
```
Then set `API_IMAGE=ghcr.io/<youruser>/inventorypro-api:latest` in `.env` and
remove the `build:` block from the compose (or just never pass `--build`).

### Build-on-Unraid
Clone the monorepo onto Unraid and let compose build it (`--build`). Works, but
needs the full repo + build toolchain on the box.

---

## 2. Bring up the stack

On Unraid (Compose Manager plugin → new stack), paste `docker-compose.prod.yml`
and create a `.env` from `.env.prod.example`. Then:

```bash
docker compose -f docker-compose.prod.yml up -d
```

The API runs its Postgres migrations automatically on first start, and
`minio-init` creates the media bucket. Check:
```bash
docker compose -f docker-compose.prod.yml logs api | grep -E "migration|listening"
curl http://<unraid-ip>:3000/health    # -> {"ok":true,...}
```

---

## 3. Configure NPM proxy hosts

For each domain, add a **Proxy Host** in NPM:

| Domain                  | Forward Host  | Forward Port | Notes                                  |
|-------------------------|---------------|--------------|----------------------------------------|
| api.invenpro.app     | `<unraid-ip>` | `3000`       | Websockets off; request SSL cert       |
| s3.invenpro.app      | `<unraid-ip>` | `9000`       | **Set client max body size** (below)   |
| minio.invenpro.app   | `<unraid-ip>` | `9001`       | Optional admin console; enable WS      |

For all three: **SSL tab → request a Let's Encrypt cert + Force SSL + HTTP/2.**

**Important for `s3.invenpro.app`** (media uploads): in the proxy host’s
**Advanced** tab add:
```
client_max_body_size 100m;
proxy_set_header Host $host;
```
The `Host` header must be preserved or MinIO will reject the presigned-URL
signature. Raise `client_max_body_size` to whatever your largest video allows.

---

## 4. Fill in `.env` to match those domains

```ini
MINIO_PUBLIC_ENDPOINT=https://s3.invenpro.app
PUBLIC_MEDIA_URL=https://s3.invenpro.app/inventorypro-media
MINIO_CONSOLE_URL=https://minio.invenpro.app
```
`MINIO_PUBLIC_ENDPOINT` is what the API bakes into the signed upload URLs the
phone uploads to — it must be the public `s3.` host, not `minio:9000`.

After editing `.env`: `docker compose -f docker-compose.prod.yml up -d`.

---

## 5. Point the app at it (use it on the go)

Set the mobile app’s API base to the public API and build a standalone APK that
no longer needs the USB tunnel or Metro:

```bash
# apps/mobile/.env.production
EXPO_PUBLIC_API_URL=https://api.invenpro.app
```
Then build an installable APK (cloud build, works over cellular):
```bash
cd apps/mobile
eas build --platform android --profile preview
```
Install the resulting APK on the Pixel. It talks to `api.invenpro.app` from
anywhere — first sign-in online, biometrics after that. JS updates can be pushed
over-the-air later with `eas update` instead of rebuilding.

---

## 6. Backups (do this before real data)

The two stateful volumes are `pgdata` and `miniodata`.
```bash
# Postgres dump (cron this on Unraid):
docker exec <postgres-container> pg_dump -U inventorypro inventorypro | gzip > backup-$(date +%F).sql.gz
```
Add both volumes to your Unraid appdata backup schedule.
