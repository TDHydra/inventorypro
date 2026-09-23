#!/usr/bin/env bash
# Local dev API on :3001 against the invenpro-dev-pg docker (127.0.0.1:5433).
# Dev-only credentials — nothing here is a secret. See docs/REBUILD-NOTES.md
# "Dev environment". Start the PG container first: docker start invenpro-dev-pg
set -euo pipefail
cd "$(dirname "$0")/../apps/api"
PORT=3001 \
DATABASE_URL=postgres://invenpro:devlocal@127.0.0.1:5433/inventorypro \
JWT_SECRET=dev-local-secret-not-prod-0123456789abcdef \
CORS_ORIGINS=http://localhost:8081,http://localhost:8082,http://localhost:8083 \
MINIO_ENDPOINT=http://127.0.0.1:9000 \
MINIO_ACCESS_KEY=devstub \
MINIO_SECRET_KEY=devstub \
MINIO_BUCKET=invenpro-dev \
exec npx tsx src/index.ts
