#!/bin/sh
# All-in-one entrypoint: first-run initdb + role/db creation, then hand off to
# supervisord, which runs postgres and the API (the API program waits for
# pg_isready before starting node; migrations run automatically on API boot).
set -eu

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
POSTGRES_DB="${POSTGRES_DB:-inventorypro}"
POSTGRES_USER="${POSTGRES_USER:-inventorypro}"

mkdir -p "$PGDATA" /run/postgresql
chown -R postgres:postgres "$PGDATA" /run/postgresql
chmod 700 "$PGDATA"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
    echo "[allinone] empty data dir — running initdb"
    # trust auth is loopback-only: postgres is never exposed outside the
    # container (supervisord starts it with listen_addresses=127.0.0.1).
    su-exec postgres initdb -D "$PGDATA" -U postgres \
        --auth-local=trust --auth-host=trust --encoding=UTF8

    # Temporarily start postgres (socket only) to create the app role + db,
    # wait until it's ready, then stop — supervisord owns the real lifecycle.
    su-exec postgres pg_ctl -D "$PGDATA" -w -t 60 \
        -o "-c listen_addresses=''" start

    until su-exec postgres pg_isready -q; do sleep 1; done

    su-exec postgres psql -U postgres -v ON_ERROR_STOP=1 <<EOSQL
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${POSTGRES_USER}') THEN
        CREATE ROLE "${POSTGRES_USER}" LOGIN;
    END IF;
END
\$\$;
EOSQL
    if ! su-exec postgres psql -U postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname = '${POSTGRES_DB}'" | grep -q 1; then
        su-exec postgres createdb -U postgres -O "${POSTGRES_USER}" "${POSTGRES_DB}"
    fi

    su-exec postgres pg_ctl -D "$PGDATA" -m fast -w stop
    echo "[allinone] initdb complete (db=${POSTGRES_DB} user=${POSTGRES_USER})"
fi

exec supervisord -c /etc/supervisord.conf
