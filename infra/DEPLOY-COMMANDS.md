# InventoryPro — Unraid deploy command sheet

Copy/paste sheet for shipping the API image to Unraid and bringing the stack up
behind Nginx Proxy Manager (NPM). Replace the two placeholders before running:

- `<UNRAID-IP>` — your Unraid box's LAN IP (e.g. `10.0.20.5`)
- `invenpro.app` — your domain (already set in the env if you use this one)

> Self-hosting on your own box instead of this Unraid/NPM setup? See
> [DEPLOY-SELFHOST.md](DEPLOY-SELFHOST.md) (root `docker compose up -d` stack or
> the all-in-one API+Postgres image).

The tarball was rebuilt **2026-06-26** and includes: user edit/roles screens,
`reset_pin`, and the `role_settings` sync fix.

---

## 1. Copy files to Unraid (run on THIS machine)

```bash
# Make the target dir on Unraid (one-time)
ssh root@<UNRAID-IP> 'mkdir -p /mnt/user/appdata/inventorypro'

# The API image (81 MB) + the two compose/env files
scp ~/inventorypro/inventorypro-api.tar.gz \
    ~/inventorypro/infra/docker-compose.prod.yml \
    ~/inventorypro/infra/.env.prod.example \
    root@<UNRAID-IP>:/mnt/user/appdata/inventorypro/
```

---

## 2. Load image + start stack (run on UNRAID, via terminal or SSH)

```bash
cd /mnt/user/appdata/inventorypro

# Load the prebuilt API image (tag inside = inventorypro-api:latest,
# which is exactly what the compose file defaults to — no rebuild happens)
docker load -i inventorypro-api.tar.gz

# Create the real env file from the template, then edit it (step 3)
cp .env.prod.example .env
nano .env        # fill in the secrets below

# Bring it all up (postgres + minio + minio-init + api)
docker compose -f docker-compose.prod.yml up -d

# Watch it come healthy / migrations run
docker compose -f docker-compose.prod.yml logs -f api
```

Migrations run automatically on API startup. You should see them apply, then
`Server listening on 0.0.0.0:3000`.

---

## 3. `.env` values (paste into the file from step 2)

```ini
POSTGRES_DB=inventorypro
POSTGRES_USER=inventorypro
POSTGRES_PASSWORD=<secret — set in infra/.env on the server; never commit>

MINIO_ROOT_USER=inventorypro
MINIO_ROOT_PASSWORD=<secret — set in infra/.env on the server; never commit>
MINIO_BUCKET=inventorypro-media

JWT_SECRET=<secret — set in infra/.env on the server; never commit>

MINIO_PUBLIC_ENDPOINT=https://s3.invenpro.app
PUBLIC_MEDIA_URL=https://s3.invenpro.app/inventorypro-media
MINIO_CONSOLE_URL=https://minio.invenpro.app

API_PORT=3100
MINIO_PORT=9000
MINIO_CONSOLE_PORT=9001
API_IMAGE=inventorypro-api:latest
```

> **Port conflict?** `API_PORT` is the HOST port only — the container still
> listens on 3000 internally, so you never touch the image. If Unraid says
> `bind: address already in use`, pick any free port here (e.g. `3100`, `3200`,
> `8088`) and re-run `docker compose -f docker-compose.prod.yml up -d`. Then
> point the `api.invenpro.app` NPM proxy at that same port. Same applies to
> `MINIO_PORT` / `MINIO_CONSOLE_PORT` if 9000/9001 are taken.

> These secrets were generated for this project. Rotate them anytime — change
> `.env` and `docker compose ... up -d` to re-apply. (Changing `JWT_SECRET`
> logs everyone out; changing `POSTGRES_PASSWORD` after first boot also needs
> the password changed inside Postgres, so set it before the very first start.)

---

## 4. Seed the database (one-time, optional — 13 demo users)

Only if you want the demo data (admin "Alex Admin" PIN `12345678`). Skip for a
clean production start.

```bash
cd /mnt/user/appdata/inventorypro
# the seed file isn't in the image; scp it first from your machine:
#   scp ~/inventorypro/apps/api/src/db/seeds/seed.sql root@<UNRAID-IP>:/mnt/user/appdata/inventorypro/
cat seed.sql | docker compose -f docker-compose.prod.yml exec -T postgres \
    psql -U inventorypro -d inventorypro
```

---

## 5. NPM proxy hosts

Minimum to launch is the **first row**. The `s3.` row is required once media
uploads are used; `minio.` is optional (admin console only).

| Domain | Scheme | Forward host / IP | Port | Extra (Advanced tab) |
|---|---|---|---|---|
| `api.invenpro.app`   | http | `<UNRAID-IP>` | `3100` | match `API_PORT` in `.env` |
| `s3.invenpro.app`    | http | `<UNRAID-IP>` | `9000` | see snippet below |
| `minio.invenpro.app` | http | `<UNRAID-IP>` | `9001` | (optional) |

For each: **SSL tab → request a Let's Encrypt cert + Force SSL.**

`s3.invenpro.app` → Advanced → Custom Nginx Configuration:
```nginx
client_max_body_size 100m;          # allow photo/video uploads
proxy_set_header Host $host;         # MinIO presigned URLs need the real host
proxy_set_header X-Real-IP $remote_addr;
```

---

## 6. Verify

```bash
# API over HTTPS (expect {"ok":true,...})
curl https://api.invenpro.app/health
```

Once that returns `ok`, tell me and I'll kick off the standalone "on the go"
APK build (`eas build --profile preview`, which points at `api.invenpro.app`).

---

## Updating later (new API build)

```bash
# on your machine, after rebuilding:
#   docker tag infra-api:latest inventorypro-api:latest
#   docker save inventorypro-api:latest | gzip > inventorypro-api.tar.gz
scp ~/inventorypro/inventorypro-api.tar.gz root@<UNRAID-IP>:/mnt/user/appdata/inventorypro/
# on Unraid:
docker load -i inventorypro-api.tar.gz
docker compose -f docker-compose.prod.yml up -d   # recreates only the api container
```
Postgres data and MinIO objects persist in named volumes across updates.
