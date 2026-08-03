# Backups & restore

Automatic backups are set up on the VPS by `infra/vps/setup-backups.sh`
(run once, as root, after `install.sh`). This doc is the operator's
reference: what is backed up, where it goes, and how to restore.

## What runs

| Piece | Detail |
|---|---|
| Schedule | systemd timer `inventorypro-backup.timer`, nightly 03:30 (±15 min jitter), catch-up after downtime (`Persistent=true`) |
| Postgres | `pg_dump -Fc` (custom format) gzipped → `/opt/inventorypro/backups/db/db-YYYY-MM-DD.dump.gz`, **14 daily dumps kept** |
| Media (MinIO) | incremental `rsync --delete` mirror of the `inventorypro_miniodata` docker volume → `/opt/inventorypro/backups/media/` (one rolling copy) |
| Off-site | after every run, `rclone sync` of the whole backup dir → Google Drive folder `InventoryPro-Backups` — **only if** a `gdrive` remote is connected |
| Log | `/var/log/inventorypro-backup.log` (one `OK`/`FAIL` line per run) |
| Monitoring | pings `HC_URL_BACKUP` (or the manual heartbeat) from `/opt/inventorypro/healthchecks.env` if present |
| On demand | `/opt/inventorypro/bin/backup.sh` any time |

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
