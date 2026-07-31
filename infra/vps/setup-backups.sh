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
#       - Media:     incremental rsync mirror of the MinIO data volume
#     into /opt/inventorypro/backups (root-only)
#   * Off-site: if an rclone remote named 'gdrive' exists, the whole backup
#     dir is synced to Google Drive after every run. Connect one with
#         /opt/inventorypro/bin/connect-gdrive.sh
#   * Logs to /var/log/inventorypro-backup.log; pings healthchecks.io if
#     HC_URL_BACKUP (or the manual heartbeat) is configured
#   * /opt/inventorypro/bin/backup.sh — run any time for an on-demand backup
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

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/media" "$BIN_DIR"
chmod 700 "$BACKUP_DIR"

# --- rclone (for the Google Drive off-site leg) ----------------------------
if ! command -v rclone >/dev/null 2>&1; then
  echo "Installing rclone…"
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

# shellcheck disable=SC1091
source "$INSTALL_DIR/.env"
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

# 2) Media — incremental mirror of the MinIO data volume. Objects are
# immutable once written (unguessable keys, no in-place rewrite), so a
# file-level mirror restores cleanly by copying back before starting MinIO.
vol=$(docker volume inspect -f '{{.Mountpoint}}' inventorypro_miniodata 2>/dev/null) \
  || fail "minio volume not found"
rsync -a --delete "$vol/" "$BACKUP_DIR/media/" || fail "media rsync"

# 3) Local retention — daily DB dumps beyond DB_KEEP_DAYS go away; the media
# mirror is a single rolling copy (history lives off-site / in Drive's trash).
find "$BACKUP_DIR/db" -name 'db-*.dump.gz' -mtime +"$DB_KEEP_DAYS" -delete

# 4) Off-site — only if a remote is connected (bin/connect-gdrive.sh).
offsite=skipped
if rclone listremotes 2>/dev/null | grep -q "^$RCLONE_REMOTE:"; then
  rclone sync "$BACKUP_DIR" "$RCLONE_REMOTE:$RCLONE_DEST" \
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

# --- optional: dedicated healthchecks.io check ------------------------------
# If install.sh set up per-check monitoring (HC_URL_* in healthchecks.env) you
# can add a 'backup' check there (timeout 1 day + grace) and append
#   HC_URL_BACKUP=<ping url>
# to /opt/inventorypro/healthchecks.env — backup.sh pings it automatically.

echo
echo "Running a first backup now (proves the whole chain)…"
"$BIN_DIR/backup.sh"
tail -1 "$LOG"
echo
echo "✔ Backups configured:"
echo "    nightly timer   systemctl list-timers inventorypro-backup.timer"
echo "    on demand       $BIN_DIR/backup.sh"
echo "    Google Drive    $BIN_DIR/connect-gdrive.sh   (off-site is OFF until connected)"
echo "    restore guide   docs/BACKUPS.md in the repo"
