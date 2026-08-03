#!/usr/bin/env bash
#
# InventoryPro automatic backups — run AFTER install.sh, as root, on the VPS
# ==========================================================================
#
#     scp infra/vps/setup-backups.sh root@<vps-ip>:
#     ssh root@<vps-ip> bash setup-backups.sh
#
# What you get:
#   * Nightly backup (03:30 + jitter, systemd timer) of
#       - Postgres:  pg_dump custom-format dump, gzipped, 14 daily kept
#       - Media:     dated hardlink snapshot (7 kept) + incremental rsync
#                     mirror of the MinIO data volume
#     into /opt/inventorypro/backups (root-only)
#   * #239: 4-hourly Postgres dumps (12 kept, ~48h of coverage) into
#     backups/db/4h — a tighter RPO than the nightly dump for the "someone
#     fat-fingered data 2 hours ago" case, without keeping 4-hourly forever.
#   * Off-site: if an rclone remote named 'gdrive' exists, the whole backup
#     dir is synced to Google Drive after every run. Connect one with
#         /opt/inventorypro/bin/connect-gdrive.sh
#   * Logs to /var/log/inventorypro-backup.log; pings healthchecks.io if
#     HC_URL_BACKUP (or the manual heartbeat) is configured
#   * /opt/inventorypro/bin/backup.sh — run any time for an on-demand backup
#   * /opt/inventorypro/bin/backup-4h.sh — run any time for an on-demand
#     4-hourly-tier dump
#
# Restore procedure: see docs/BACKUPS.md in the repo.
#
set -Eeuo pipefail

INSTALL_DIR=/opt/inventorypro
BIN_DIR=$INSTALL_DIR/bin
ENV_FILE=$INSTALL_DIR/.env
BACKUP_DIR=$INSTALL_DIR/backups
HC_ENV_FILE=$INSTALL_DIR/healthchecks.env
LOG=/var/log/inventorypro-backup.log

RCLONE_REMOTE=gdrive
RCLONE_DEST=InventoryPro-Backups
DB_KEEP_DAYS=14

[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
[[ -f $ENV_FILE ]] || { echo "$ENV_FILE not found — run install.sh first." >&2; exit 1; }

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/db/4h" "$BACKUP_DIR/media" "$BACKUP_DIR/media-snapshots" "$BIN_DIR"
chmod 700 "$BACKUP_DIR"

# --- rclone (for the Google Drive off-site leg) ----------------------------
if ! command -v rclone >/dev/null 2>&1; then
  echo "Installing rclone…"
  # NEEDRESTART_MODE=a: without it needrestart may bounce services (incl.
  # sshd/docker) mid-install and kill the very session running this script.
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
  apt-get install -y -qq rclone >/dev/null 2>&1 || curl -fsSL https://rclone.org/install.sh | bash
fi
echo "rclone: $(rclone version | head -1)"

# --- the backup job itself -------------------------------------------------
cat >"$BIN_DIR/backup.sh" <<'EOF'
#!/usr/bin/env bash
# InventoryPro backup — run nightly by inventorypro-backup.timer, or by hand.
set -Eeuo pipefail
INSTALL_DIR=/opt/inventorypro
BACKUP_DIR=$INSTALL_DIR/backups
LOG=/var/log/inventorypro-backup.log
COMPOSE="docker compose --project-name inventorypro --env-file $INSTALL_DIR/.env -f $INSTALL_DIR/app/infra/docker-compose.prod.yml -f $INSTALL_DIR/compose.vps.yml"
RCLONE_REMOTE=gdrive
RCLONE_DEST=InventoryPro-Backups
DB_KEEP_DAYS=14

# .env is compose-format, not valid bash (e.g. SMTP_FROM has unquoted spaces
# and <angle brackets>) — never `source` it; pluck the keys we need instead.
env_get() { grep -m1 "^$1=" "$INSTALL_DIR/.env" | cut -d= -f2-; }
POSTGRES_USER=$(env_get POSTGRES_USER)
POSTGRES_DB=$(env_get POSTGRES_DB)
[ -n "$POSTGRES_USER" ] && [ -n "$POSTGRES_DB" ] || { echo "POSTGRES_USER/DB missing from .env" >&2; exit 1; }
# healthchecks.env is written by install.sh as plain KEY=url lines — safe.
# shellcheck disable=SC1091
source "$INSTALL_DIR/healthchecks.env" 2>/dev/null || true

logline() { printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG"; }
fail() {
  logline "FAIL $*"
  url=${HC_URL_BACKUP:-${HC_HEARTBEAT_URL:-}}
  [ -n "$url" ] && curl -fsS -m 10 --retry 2 -o /dev/null --data-raw "$*" "$url/fail" || true
  exit 1
}

stamp=$(date +%F)
umask 077

# 1) Postgres — custom-format dump (pg_restore-able), gzipped.
$COMPOSE exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" \
  | gzip >"$BACKUP_DIR/db/db-$stamp.dump.gz" \
  || fail "pg_dump"
[ -s "$BACKUP_DIR/db/db-$stamp.dump.gz" ] || fail "pg_dump produced an empty file"

# 2) Media — dated hardlink snapshot of YESTERDAY's mirror state, THEN refresh
# the mirror. `backups/media/` is a single rolling copy with no history of its
# own (#239's original design): `rsync --delete` on a rolling mirror means a
# file deleted from MinIO between two runs is just gone from the backup too —
# no way to recover "the media that existed 3 days ago". `cp -al` hardlinks
# every unchanged file into today's snapshot dir (near-zero extra disk: MinIO
# objects are immutable/never rewritten in place, so nothing here is ever
# copy-on-write'd) before the mirror below moves forward, giving 7 rolling
# days of undo without duplicating storage.
if [ -d "$BACKUP_DIR/media" ] && [ -n "$(ls -A "$BACKUP_DIR/media" 2>/dev/null)" ]; then
  rm -rf "$BACKUP_DIR/media-snapshots/$stamp" # re-running same-day: cp -al into an existing dir nests instead of replacing
  cp -al "$BACKUP_DIR/media" "$BACKUP_DIR/media-snapshots/$stamp" || fail "media snapshot"
fi
# keep the 7 newest snapshot dirs (name-sorted == date-sorted, YYYY-MM-DD).
# find, not a glob: under pipefail an unmatched glob makes `ls` abort the whole
# script — and media-snapshots/ IS empty on the feature's first-ever run.
find "$BACKUP_DIR/media-snapshots" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -r | tail -n +8 | xargs -r rm -rf

vol=$(docker volume inspect -f '{{.Mountpoint}}' inventorypro_miniodata 2>/dev/null) \
  || fail "minio volume not found"
rsync -a --delete "$vol/" "$BACKUP_DIR/media/" || fail "media rsync"

# 3) Local retention — daily DB dumps beyond DB_KEEP_DAYS go away; the media
# mirror is a single rolling copy (history lives in media-snapshots/ above,
# and off-site / in Drive's trash).
find "$BACKUP_DIR/db" -name 'db-*.dump.gz' -mtime +"$DB_KEEP_DAYS" -delete

# 4) Off-site — only if a remote is connected (bin/connect-gdrive.sh).
offsite=skipped
if rclone listremotes 2>/dev/null | grep -q "^$RCLONE_REMOTE:"; then
  # media-snapshots/ is excluded: its hardlink dedup doesn't survive rclone
  # (Drive would store 7 FULL media copies + the live mirror ≈ 8x quota/
  # bandwidth). Off-site history = daily dumps + Drive's own trash/versioning.
  rclone sync "$BACKUP_DIR" "$RCLONE_REMOTE:$RCLONE_DEST" \
    --exclude '/media-snapshots/**' \
    --transfers 4 --log-level ERROR --log-file "$LOG" \
    || fail "rclone sync to $RCLONE_REMOTE"
  offsite=ok
fi

size=$(du -sh "$BACKUP_DIR" | cut -f1)
logline "OK db=db-$stamp.dump.gz media=$(du -sh "$BACKUP_DIR/media" | cut -f1) total=$size offsite=$offsite"
url=${HC_URL_BACKUP:-}
[ -n "$url" ] && curl -fsS -m 10 --retry 2 -o /dev/null "$url" || true
EOF
chmod 700 "$BIN_DIR/backup.sh"

# --- 4-hourly Postgres dump tier (#239) -------------------------------------
# Same pg_dump the nightly job does, but DB-only (no media, no off-site — the
# nightly run already covers those, and re-mirroring/re-syncing media every
# 4h would be pure I/O for no extra safety since it's a rolling mirror) and a
# short 12-dump retention (~48h at this cadence) instead of DB_KEEP_DAYS. This
# tightens the RPO for the DB specifically: the nightly-only tier means a bad
# write at 4am can cost up to ~23h of data if you're restoring to "before it
# happened"; the 4-hourly tier caps that at under 4h.
cat >"$BIN_DIR/backup-4h.sh" <<'EOF'
#!/usr/bin/env bash
# InventoryPro 4-hourly DB dump — run by inventorypro-backup-4h.timer, or by
# hand. DB-only, short retention — see docs/BACKUPS.md "4-hourly dumps".
set -Eeuo pipefail
INSTALL_DIR=/opt/inventorypro
BACKUP_DIR=$INSTALL_DIR/backups/db/4h
LOG=/var/log/inventorypro-backup.log
COMPOSE="docker compose --project-name inventorypro --env-file $INSTALL_DIR/.env -f $INSTALL_DIR/app/infra/docker-compose.prod.yml -f $INSTALL_DIR/compose.vps.yml"
KEEP=12

env_get() { grep -m1 "^$1=" "$INSTALL_DIR/.env" | cut -d= -f2-; }
POSTGRES_USER=$(env_get POSTGRES_USER)
POSTGRES_DB=$(env_get POSTGRES_DB)
[ -n "$POSTGRES_USER" ] && [ -n "$POSTGRES_DB" ] || { echo "POSTGRES_USER/DB missing from .env" >&2; exit 1; }

logline() { printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG"; }
fail() { logline "FAIL (4h) $*"; exit 1; }

stamp=$(date +%F_%H%M)
umask 077
mkdir -p "$BACKUP_DIR"

$COMPOSE exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" \
  | gzip >"$BACKUP_DIR/db-$stamp.dump.gz" \
  || fail "pg_dump"
[ -s "$BACKUP_DIR/db-$stamp.dump.gz" ] || fail "pg_dump produced an empty file"

# keep only the KEEP newest — count-based, not time-based: at a 4h cadence a
# `-mtime` retention window would need constant tuning to stay at "12 dumps".
ls -1t "$BACKUP_DIR"/db-*.dump.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

logline "OK (4h) db=db-$stamp.dump.gz"
EOF
chmod 700 "$BIN_DIR/backup-4h.sh"

# --- Google Drive quick-connect --------------------------------------------
cat >"$BIN_DIR/connect-gdrive.sh" <<'EOF'
#!/usr/bin/env bash
# Connect a Google Drive account for off-site backups (rclone remote 'gdrive').
# Safe to re-run — reconnecting replaces the stored token.
set -Eeuo pipefail

echo "This VPS has no browser, so the Google login happens on your computer:"
echo
echo "  1. Install rclone there (https://rclone.org/downloads/ — one binary)."
echo "  2. Run:   rclone authorize \"drive\""
echo "  3. A browser opens — log in with the Google account that should"
echo "     receive the backups and approve access."
echo "  4. rclone prints a token between  --->  markers. Copy the whole"
echo "     {...} JSON line and paste it below."
echo
read -rp "Paste token JSON: " token </dev/tty
[[ $token == *'"access_token"'* ]] || { echo "That doesn't look like an rclone token." >&2; exit 1; }

# scope=drive.file: the token can only see files THIS remote creates —
# the backups folder — never the rest of the account's Drive.
rclone config create gdrive drive scope drive.file token "$token" config_refresh_token false >/dev/null
echo "Testing…"
rclone mkdir gdrive:InventoryPro-Backups
rclone lsd gdrive: >/dev/null
echo "✔ Connected. Nightly backups now sync to Drive folder 'InventoryPro-Backups'."
echo "  Push everything up right now with: /opt/inventorypro/bin/backup.sh"
EOF
chmod 700 "$BIN_DIR/connect-gdrive.sh"

# --- monthly restore test (#209) -------------------------------------------
# A backup you've never restored isn't a backup. This automates the quarterly
# manual verify from docs/BACKUPS.md: restore the newest dump into a scratch
# database, sanity-check it, drop it.
cat >"$BIN_DIR/restore-test.sh" <<'EOF'
#!/usr/bin/env bash
# InventoryPro restore test — run monthly by inventorypro-restore-test.timer,
# or by hand. Proves the newest nightly dump actually pg_restores.
set -Eeuo pipefail
INSTALL_DIR=/opt/inventorypro
BACKUP_DIR=$INSTALL_DIR/backups
LOG=/var/log/inventorypro-restore-test.log
COMPOSE="docker compose --project-name inventorypro --env-file $INSTALL_DIR/.env -f $INSTALL_DIR/app/infra/docker-compose.prod.yml -f $INSTALL_DIR/compose.vps.yml"

# .env is compose-format, not valid bash — pluck keys, never `source` it.
env_get() { grep -m1 "^$1=" "$INSTALL_DIR/.env" | cut -d= -f2-; }
POSTGRES_USER=$(env_get POSTGRES_USER)
[ -n "$POSTGRES_USER" ] || { echo "POSTGRES_USER missing from .env" >&2; exit 1; }
# shellcheck disable=SC1091
source "$INSTALL_DIR/healthchecks.env" 2>/dev/null || true

logline() { printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG"; }
fail() {
  logline "FAIL $*"
  url=${HC_URL_RESTORE_TEST:-}
  [ -n "$url" ] && curl -fsS -m 10 --retry 2 -o /dev/null --data-raw "$*" "$url/fail" || true
  exit 1
}

latest=$(ls -1t "$BACKUP_DIR"/db/db-*.dump.gz 2>/dev/null | head -1)
[ -n "$latest" ] || fail "no dump found in $BACKUP_DIR/db"
# A dump older than 2 days means the nightly backup itself is broken — that's
# a restore-test failure too, not something to silently pass over.
[ -n "$(find "$latest" -mtime -2)" ] || fail "latest dump is stale: $latest"

$COMPOSE exec -T postgres dropdb -U "$POSTGRES_USER" --if-exists restore_test
$COMPOSE exec -T postgres createdb -U "$POSTGRES_USER" restore_test || fail "createdb"
gunzip -c "$latest" \
  | $COMPOSE exec -T postgres pg_restore -U "$POSTGRES_USER" -d restore_test --no-owner \
  || fail "pg_restore $(basename "$latest")"
users=$($COMPOSE exec -T postgres psql -U "$POSTGRES_USER" -d restore_test -Atc 'SELECT count(*) FROM users;') \
  || fail "sanity query"
[ "${users:-0}" -ge 1 ] || fail "restored users table is empty"
$COMPOSE exec -T postgres dropdb -U "$POSTGRES_USER" restore_test || true

logline "OK dump=$(basename "$latest") users=$users"
url=${HC_URL_RESTORE_TEST:-}
[ -n "$url" ] && curl -fsS -m 10 --retry 2 -o /dev/null "$url" || true
EOF
chmod 700 "$BIN_DIR/restore-test.sh"

cat >/etc/systemd/system/inventorypro-restore-test.service <<'EOF'
[Unit]
Description=InventoryPro monthly restore test (newest dump into scratch DB)
[Service]
Type=oneshot
ExecStart=/opt/inventorypro/bin/restore-test.sh
EOF
cat >/etc/systemd/system/inventorypro-restore-test.timer <<'EOF'
[Unit]
Description=Run InventoryPro restore test monthly
[Timer]
OnCalendar=*-*-01 04:30
RandomizedDelaySec=30min
Persistent=true
[Install]
WantedBy=timers.target
EOF

# --- 4-hourly DB dump timer (#239) ------------------------------------------
cat >/etc/systemd/system/inventorypro-backup-4h.service <<'EOF'
[Unit]
Description=InventoryPro 4-hourly Postgres dump (short-retention RPO tier)
[Service]
Type=oneshot
ExecStart=/opt/inventorypro/bin/backup-4h.sh
EOF
cat >/etc/systemd/system/inventorypro-backup-4h.timer <<'EOF'
[Unit]
Description=Run InventoryPro 4-hourly Postgres dump
[Timer]
OnCalendar=*-*-* 0/4:00:00
RandomizedDelaySec=5min
Persistent=true
[Install]
WantedBy=timers.target
EOF

# --- systemd timer ----------------------------------------------------------
cat >/etc/systemd/system/inventorypro-backup.service <<'EOF'
[Unit]
Description=InventoryPro nightly backup (Postgres + media, off-site if connected)
[Service]
Type=oneshot
ExecStart=/opt/inventorypro/bin/backup.sh
EOF
cat >/etc/systemd/system/inventorypro-backup.timer <<'EOF'
[Unit]
Description=Run InventoryPro backup nightly
[Timer]
OnCalendar=*-*-* 03:30
RandomizedDelaySec=15min
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now inventorypro-backup.timer
systemctl enable --now inventorypro-backup-4h.timer
systemctl enable --now inventorypro-restore-test.timer

# --- optional: dedicated healthchecks.io check ------------------------------
# If install.sh set up per-check monitoring (HC_URL_* in healthchecks.env) you
# can add a 'backup' check there (timeout 1 day + grace) and append
#   HC_URL_BACKUP=<ping url>
# to /opt/inventorypro/healthchecks.env — backup.sh pings it automatically.
# Same for the monthly restore test (#209): add a 'restore-test' check
# (schedule: monthly, generous grace) and append
#   HC_URL_RESTORE_TEST=<ping url>

echo
echo "Running a first backup now (proves the whole chain)…"
"$BIN_DIR/backup.sh"
tail -1 "$LOG"
echo
echo "✔ Backups configured:"
echo "    nightly timer   systemctl list-timers inventorypro-backup.timer"
echo "    4-hourly timer  systemctl list-timers inventorypro-backup-4h.timer / on demand $BIN_DIR/backup-4h.sh"
echo "    restore test    monthly timer inventorypro-restore-test.timer / on demand $BIN_DIR/restore-test.sh"
echo "    on demand       $BIN_DIR/backup.sh"
echo "    Google Drive    $BIN_DIR/connect-gdrive.sh   (off-site is OFF until connected)"
echo "    warm rollback   NOT auto-installed — see docs/BACKUPS.md 'Warm rollback VM'"
echo "    restore guide   docs/BACKUPS.md in the repo"
