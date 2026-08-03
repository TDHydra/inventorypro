# Backups & restore

Automatic backups are set up on the VPS by `infra/vps/setup-backups.sh`
(run once, as root, after `install.sh`). This doc is the operator's
reference: what is backed up, where it goes, and how to restore.

## What runs

| Piece | Detail |
|---|---|
| Schedule | systemd timer `inventorypro-backup.timer`, nightly 03:30 (±15 min jitter), catch-up after downtime (`Persistent=true`) |
| Postgres | `pg_dump -Fc` (custom format) gzipped → `/opt/inventorypro/backups/db/db-YYYY-MM-DD.dump.gz`, **14 daily dumps kept** |
| Postgres, 4-hourly (#239) | separate systemd timer `inventorypro-backup-4h.timer`, every 4h → `/opt/inventorypro/backups/db/4h/db-YYYY-MM-DD_HHMM.dump.gz`, **12 dumps kept** (~48h coverage). DB-only, no media/off-site leg — see "4-hourly dumps" below |
| Media (MinIO) | dated hardlink snapshot (#239) of the previous mirror state → `/opt/inventorypro/backups/media-snapshots/YYYY-MM-DD/`, **7 days kept**, THEN an incremental `rsync --delete` mirror of the `inventorypro_miniodata` docker volume → `/opt/inventorypro/backups/media/` (one rolling copy) — see "Media snapshots" below |
| Off-site | after every nightly run, `rclone sync` of the whole backup dir (dumps, 4h dumps, media mirror, and media snapshots) → Google Drive folder `InventoryPro-Backups` — **only if** a `gdrive` remote is connected |
| Log | `/var/log/inventorypro-backup.log` (one `OK`/`FAIL` line per run; 4-hourly runs are tagged `(4h)`) |
| Monitoring | pings `HC_URL_BACKUP` (or the manual heartbeat) from `/opt/inventorypro/healthchecks.env` if present |
| On demand | `/opt/inventorypro/bin/backup.sh` (nightly tier) or `/opt/inventorypro/bin/backup-4h.sh` (4-hourly tier) any time |
| Warm rollback VM (#239, opt-in) | `infra/vps/warm-rollback-sync.sh` — restores the latest nightly dump onto the tier-1 rollback VM over SSH. **Not installed automatically** — see "Warm rollback VM" below |

## Connecting Google Drive (off-site)

```bash
/opt/inventorypro/bin/connect-gdrive.sh
```

The VPS has no browser, so the script walks you through the two-machine
flow: run `rclone authorize "drive"` on your laptop, log in with the
Google account that should hold the backups, paste the token JSON back
into the script. It verifies access, creates the `InventoryPro-Backups`
folder, and from then on every nightly run syncs there.

The token is scoped to `drive.file` — it can only see files rclone itself
creates (the backup folder), never the rest of the account's Drive.
Re-run the script any time to switch accounts or refresh a revoked token.

## 4-hourly dumps (#239)

The nightly dump alone means a bad write can cost up to ~23h of data if you
need to restore to "just before it happened". `inventorypro-backup-4h.timer`
runs a DB-only `pg_dump` every 4 hours into `backups/db/4h/`, keeping the 12
newest (~48h of coverage, count-based retention rather than a `-mtime`
window so it stays exactly "12 dumps" regardless of cadence). It skips the
media mirror and off-site sync — those stay nightly-only, since re-running
them every 4h is I/O for no extra safety on a rolling mirror.

Restoring from this tier is the same procedure as "Database (roll back to a
nightly dump)" below, just pointed at `backups/db/4h/db-YYYY-MM-DD_HHMM.dump.gz`
instead.

## Media snapshots (#239)

`backups/media/` is a single rolling mirror (`rsync -a --delete`) — by
itself it has no history: a file deleted from MinIO between two nightly runs
is simply gone from the backup too. Before each nightly mirror refresh,
`backup.sh` now takes a dated hardlink snapshot of the *previous* mirror
state into `backups/media-snapshots/YYYY-MM-DD/` (`cp -al` — hardlinks, not
copies, so unchanged objects cost no extra disk; MinIO objects are immutable
once written, so nothing here is ever silently rewritten out from under a
snapshot). The 7 newest snapshot days are kept.

To recover a since-deleted or since-overwritten media object, look for it
under the newest `media-snapshots/YYYY-MM-DD/` directory that still has it,
and copy it back into `backups/media/` (or straight into the running MinIO
volume mountpoint) before the next nightly run overwrites the mirror again.

## Warm rollback VM (#239)

The tier-1 rollback VM (`.72`, see the ops notes for host/access) has been
sitting frozen at its 2026-08-01 cutover snapshot since prod moved to the
cloud VPS — a real rollback today would lose everything written since. This
is a manual layer on top of the automated timers above, to keep that VM's
Postgres reasonably current without making cross-host SSH backup access
something an unattended installer decides on its own.

**Enabling it:**

1. Set up SSH key trust from the prod VPS's root user to the rollback VM
   (`ssh-copy-id` a dedicated key, or add the VPS's existing root key to
   that VM's `authorized_keys`) — this is the deliberate, one-time step the
   script assumes is already done and never attempts itself.
2. Copy the script onto the VPS: `scp infra/vps/warm-rollback-sync.sh
   root@<vps>:/opt/inventorypro/bin/` and `chmod 700` it (matches the other
   `bin/` scripts).
3. Run it by hand once to confirm it works: `/opt/inventorypro/bin/warm-rollback-sync.sh`
   — it restores the latest **nightly** dump (not the 4-hourly tier) into
   the rollback VM's own `postgres` container over SSH, using
   `--clean --if-exists` (same semantics as the local restore below), so it
   is destructive to whatever is currently on that VM.
4. Optional: put it on a schedule yourself (a systemd timer mirroring
   `inventorypro-backup.timer` above, or plain cron) at whatever cadence
   you're comfortable re-pointing that SSH session at prod data — this repo
   does not enable one for you.

The script reads `WARM_VM_HOST` / `WARM_VM_APP_DIR` / `WARM_VM_COMPOSE_CMD`
from the environment if the rollback VM's defaults (`pmshydra@192.168.1.72`,
`/opt/inventorypro`) or compose invocation ever change — see the comments at
the top of the script.

## Restore

Work through these on the VPS as root. `COMPOSE` below means:

```bash
COMPOSE="docker compose --project-name inventorypro --env-file /opt/inventorypro/.env \
  -f /opt/inventorypro/app/infra/docker-compose.prod.yml -f /opt/inventorypro/compose.vps.yml"
source /opt/inventorypro/.env    # for $POSTGRES_USER / $POSTGRES_DB
```

### Database (roll back to a nightly dump)

```bash
$COMPOSE stop api                                   # stop writers
gunzip -c /opt/inventorypro/backups/db/db-YYYY-MM-DD.dump.gz \
  | $COMPOSE exec -T postgres pg_restore -U "$POSTGRES_USER" \
      -d "$POSTGRES_DB" --clean --if-exists --no-owner
$COMPOSE start api
curl -fsS http://127.0.0.1:3000/health              # must return OK
```

`--clean --if-exists` drops and recreates objects, so the dump fully
replaces current state. Mobile devices whose local data is now "ahead" of
the restored DB will re-push from their outboxes on next sync; if you
restored to escape bad data, clear the relevant outbox entries on devices
or expect those rows to return.

### Media (MinIO volume)

```bash
$COMPOSE stop minio
vol=$(docker volume inspect -f '{{.Mountpoint}}' inventorypro_miniodata)
rsync -a --delete /opt/inventorypro/backups/media/ "$vol/"
$COMPOSE start minio
curl -fsS http://127.0.0.1:9000/minio/health/live
```

The mirror is a byte-for-byte copy of MinIO's data directory; restoring
it wholesale onto the **same MinIO version** is safe. Media objects are
immutable once written (unguessable keys, never rewritten in place), so
the rolling mirror never diverges mid-file.

### Full-server disaster (VPS is gone)

1. New VPS → run `infra/vps/install.sh` (same domains; DNS moves with it).
2. Run `infra/vps/setup-backups.sh` (recreates dirs + timer).
3. Pull the backup set down from Drive:
   `rclone sync gdrive:InventoryPro-Backups /opt/inventorypro/backups`
   (connect the remote first with `connect-gdrive.sh`).
4. Restore DB + media per the two sections above.
5. Devices: nothing to reinstall — same domains, same JWTs invalid though
   (new `JWT_SECRET` was generated), so users re-log-in and full-download.
   To keep old sessions valid instead, copy the old `JWT_SECRET` into
   `/opt/inventorypro/.env` before `install.sh`'s app phase / restart api.

## Verifying backups

The restore drill below is automated (#209): `inventorypro-restore-test.timer`
runs `/opt/inventorypro/bin/restore-test.sh` on the 1st of each month — it
restores the newest dump into a scratch `restore_test` database, checks the
`users` table is non-empty, drops it, logs to
`/var/log/inventorypro-restore-test.log`, and pings `HC_URL_RESTORE_TEST`
(from `/opt/inventorypro/healthchecks.env`) if configured. It also fails
loudly when the newest dump is >2 days old, catching a silently-dead backup
timer.

Occasional manual checks:

- `systemctl list-timers 'inventorypro-*'` — backup + restore-test scheduled?
- `tail /var/log/inventorypro-backup.log` — nightly `OK` lines, `offsite=ok`?
- `tail /var/log/inventorypro-restore-test.log` — monthly `OK` lines?
- Or run the drill by hand any time (same as the timer does):
  ```bash
  $COMPOSE exec -T postgres createdb -U "$POSTGRES_USER" restore_test
  gunzip -c /opt/inventorypro/backups/db/db-<latest>.dump.gz \
    | $COMPOSE exec -T postgres pg_restore -U "$POSTGRES_USER" -d restore_test --no-owner
  $COMPOSE exec -T postgres psql -U "$POSTGRES_USER" -d restore_test \
      -c 'SELECT count(*) FROM users;'
  $COMPOSE exec -T postgres dropdb -U "$POSTGRES_USER" restore_test
  ```
