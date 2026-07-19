# InventoryPro — self-host runbook

Two ways to run InventoryPro on your own box. Both build from this repo; the
API applies its own DB migrations on boot, so first start = fully migrated.

## Option A — full stack, one command (recommended)

Postgres + MinIO (media) + API + Web, from the repo root:

```bash
cp .env.example .env    # edit the CHANGE_ME values (see comments in the file)
docker compose up -d --build
```

- Web app: `http://<host>:8088` — API: `http://<host>:3000` — MinIO console: `:9001`
- `EXPO_PUBLIC_API_URL` is baked into the web bundle at **build** time; after
  changing it (or `MINIO_PUBLIC_ENDPOINT`/`PUBLIC_MEDIA_URL`), rerun with `--build`.
- For internet exposure put your own TLS reverse proxy in front (see
  `docker-compose.prod.yml` for the NPM-fronted production layout) and set
  `CORS_ORIGINS` + `TRUST_PROXY` accordingly.

## Option B — all-in-one image (API + Postgres in one container)

Smallest footprint: one container, bundled Postgres 16 (loopback-only), no
MinIO — the API **requires** `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` at boot
(fails closed), so point `MINIO_*` at an external S3/MinIO. Tradeoffs (coupled
restarts, in-container data volume) are documented in `Dockerfile.allinone`.

```bash
docker build -f infra/Dockerfile.allinone -t inventorypro-allinone .
docker run -d --name inventorypro \
  -p 3000:3000 \
  -v inventorypro-pgdata:/var/lib/postgresql/data \
  -e JWT_SECRET="$(openssl rand -base64 64 | tr -d '\n')" \
  -e MINIO_ENDPOINT=http://your-minio:9000 \
  -e MINIO_ACCESS_KEY=your_s3_key \
  -e MINIO_SECRET_KEY=your_s3_secret \
  -e MINIO_BUCKET=inventorypro-media \
  inventorypro-allinone
```

Add `-e CORS_ORIGINS=...`, `-e TRUST_PROXY=...`, `-e SMTP_*` as needed (same
variables as `.env.example`). Serve the web app separately if you want it:

```bash
docker build -f infra/Dockerfile.web \
  --build-arg EXPO_PUBLIC_API_URL=http://<host>:3000 -t inventorypro-web .
docker run -d -p 8088:80 inventorypro-web
```

## Upgrading

```bash
git pull
docker compose up -d --build        # option A
# or rebuild + recreate the allinone container (pgdata volume persists)
```

Migrations apply automatically when the new API boots.
