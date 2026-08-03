#!/usr/bin/env bash
#
# InventoryPro warm rollback sync (#239) — NOT installed by setup-backups.sh
# =============================================================================
# Restores the latest NIGHTLY dump (backups/db/db-*.dump.gz — not the
# 4-hourly tier) into the tier-1 rollback VM's own postgres over SSH, so that
# VM stays a "warm" up-to-date fallback instead of a snapshot frozen at
# whatever day the last migration happened. See docs/BACKUPS.md "Warm
# rollback VM" for what this buys you and the manual setup it requires.
#
# This is intentionally a manual install, run this from THIS repo checkout,
# not auto-wired into a timer by setup-backups.sh, for two reasons:
#   1. It needs SSH key trust from the PROD VPS to the rollback VM set up
#      first (that's a one-time, deliberate, security-relevant step — a
#      backup script silently getting a live credential to reach another
#      host is not something an automated installer should decide for you).
#   2. It's destructive on the RECEIVING end (pg_restore --clean --if-exists
#      replaces whatever's on the rollback VM), so it should run on a
#      schedule YOU chose, not one bundled default.
#
# Usage (run as root on the prod VPS, after the SSH trust step in the docs):
#   /opt/inventorypro/bin/warm-rollback-sync.sh
#
# Config (env, all overridable — defaults match the current tier-1 VM):
#   WARM_VM_HOST        ssh target, user@host                  (pmshydra@192.168.1.72)
#   WARM_VM_APP_DIR      app install dir on that host            (/opt/inventorypro)
#   WARM_VM_COMPOSE_CMD  full `docker compose ...` invocation to run there —
#                        override this whole-cloth if the rollback VM's
#                        compose project/file layout ever diverges from
#                        WARM_VM_APP_DIR's default (see docs/BACKUPS.md)
#
set -Eeuo pipefail

INSTALL_DIR=/opt/inventorypro
BACKUP_DIR=$INSTALL_DIR/backups
LOG=/var/log/inventorypro-warm-rollback.log

WARM_VM_HOST=${WARM_VM_HOST:-pmshydra@192.168.1.72}
WARM_VM_APP_DIR=${WARM_VM_APP_DIR:-/opt/inventorypro}
WARM_VM_COMPOSE_CMD=${WARM_VM_COMPOSE_CMD:-"docker compose --project-name inventorypro --env-file $WARM_VM_APP_DIR/.env -f $WARM_VM_APP_DIR/app/infra/docker-compose.prod.yml -f $WARM_VM_APP_DIR/compose.vps.yml"}

# .env is compose-format, not valid bash — pluck keys, never `source` it
# (same convention as backup.sh / restore-test.sh).
env_get() { grep -m1 "^$1=" "$INSTALL_DIR/.env" | cut -d= -f2-; }
POSTGRES_USER=$(env_get POSTGRES_USER)
POSTGRES_DB=$(env_get POSTGRES_DB)
[ -n "$POSTGRES_USER" ] && [ -n "$POSTGRES_DB" ] || { echo "POSTGRES_USER/DB missing from $INSTALL_DIR/.env" >&2; exit 1; }

logline() { printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG"; }
fail() { logline "FAIL $*"; exit 1; }

latest=$(ls -1t "$BACKUP_DIR"/db/db-*.dump.gz 2>/dev/null | head -1)
[ -n "$latest" ] || fail "no nightly dump found in $BACKUP_DIR/db"

# Ship the dump over still-gzipped (the far side does its own gunzip |
# pg_restore, same shape as the local restore in docs/BACKUPS.md) into a
# scratch path, restore it there, then clean up the copy.
remote_dump="/tmp/$(basename "$latest")"
scp -q "$latest" "$WARM_VM_HOST:$remote_dump" || fail "scp $latest -> $WARM_VM_HOST"

ssh "$WARM_VM_HOST" bash -s -- "$remote_dump" "$POSTGRES_USER" "$POSTGRES_DB" "$WARM_VM_COMPOSE_CMD" <<'REMOTE' || fail "remote restore on $WARM_VM_HOST"
set -Eeuo pipefail
dump=$1; user=$2; db=$3; compose=$4
$compose up -d postgres
gunzip -c "$dump" | $compose exec -T postgres pg_restore -U "$user" -d "$db" --clean --if-exists --no-owner
rm -f "$dump"
REMOTE

logline "OK restored $(basename "$latest") onto $WARM_VM_HOST"
