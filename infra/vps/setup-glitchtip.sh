#!/usr/bin/env bash
#
# InventoryPro — GlitchTip self-hosted error tracking (#213) — run AFTER
# install.sh, as root, on the VPS
# ==========================================================================
#
#     scp infra/vps/setup-glitchtip.sh root@<vps-ip>:
#     ssh root@<vps-ip> bash setup-glitchtip.sh
#
# What you get:
#   * GlitchTip (Sentry-protocol-compatible, github.com/glitchtip/glitchtip)
#     as its OWN docker compose project (`inventorypro-glitchtip`): web +
#     worker + redis-compatible cache/broker (Valkey) + a DEDICATED Postgres
#     — deliberately its own container, own volume, own credentials, kept
#     out of the main InventoryPro Postgres and out of setup-backups.sh's
#     dump/restore/off-site lifecycle (see docs/GLITCHTIP.md "Backup
#     coverage" for why that's an accepted tradeoff, not an oversight).
#   * A dedicated Cloudflare A record + a SEPARATE Let's Encrypt certificate
#     (--cert-name inventorypro-glitchtip) — never added as a 5th SAN on the
#     main "inventorypro" cert, so GlitchTip's cert lifecycle (and removal)
#     never touches the app's.
#   * A host-nginx vhost on the same TLS edge install.sh already set up.
#   * Secrets (SECRET_KEY, dedicated Postgres password) generated for you
#     into a root-only env file — nothing sensitive is prompted for.
#
# You will be asked ONE question: the subdomain to serve GlitchTip on
# (default errors.invenpro.app). Everything else reuses what install.sh
# already collected in /opt/inventorypro/install.conf (Cloudflare token/
# zone/public IP) and /root/.secrets/certbot-cloudflare.ini.
#
# Re-running this script is safe: the subdomain answer, generated secrets,
# DNS record, certificate and nginx vhost are all reused/overwritten in
# place rather than duplicated.
#
# To remove GlitchTip entirely later: stop+wipe its compose project, delete
# its cert, its nginx vhost and its Cloudflare A record — see
# docs/GLITCHTIP.md "Removing GlitchTip".
#
set -Eeuo pipefail

INSTALL_DIR=/opt/inventorypro
CONF_FILE=$INSTALL_DIR/install.conf
GT_CONF_FILE=$INSTALL_DIR/glitchtip.conf
GT_ENV_FILE=$INSTALL_DIR/glitchtip.env
GT_COMPOSE_FILE=$INSTALL_DIR/compose.glitchtip.yml
CF_INI=/root/.secrets/certbot-cloudflare.ini
CERT_NAME=inventorypro-glitchtip
CERT_DIR=/etc/letsencrypt/live/$CERT_NAME
GT_WEB_PORT=8090
LOG_FILE=/var/log/inventorypro-glitchtip-setup.log

GT_COMPOSE="docker compose --project-name inventorypro-glitchtip --env-file $GT_ENV_FILE -f $GT_COMPOSE_FILE"

# ---------------------------------------------------------------------------
# Output helpers (small self-contained copy of install.sh's — this script
# does not source install.sh's function library, only its answers file)
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RED=$'\e[31m' C_GRN=$'\e[32m' C_YEL=$'\e[33m' C_BLD=$'\e[1m' C_OFF=$'\e[0m'
else
  C_RED='' C_GRN='' C_YEL='' C_BLD='' C_OFF=''
fi
touch "$LOG_FILE" 2>/dev/null || true
log()  { printf '%s\n' "$*" >>"$LOG_FILE" 2>/dev/null || true; }
info() { printf '%s\n'  "  $*";                    log "INFO  $*"; }
ok()   { printf '%s\n'  "${C_GRN}  ✔ $*${C_OFF}";  log "OK    $*"; }
warn() { printf '%s\n'  "${C_YEL}  ⚠ $*${C_OFF}";  log "WARN  $*"; }
err()  { printf '%s\n'  "${C_RED}  ✘ $*${C_OFF}" >&2; log "ERROR $*"; }
step() { printf '\n%s\n' "${C_BLD}==> $*${C_OFF}"; log "STEP  $*"; }
die()  { err "$*"; exit 1; }

confirm() { # confirm "question" [default-yes]
  local q=$1 def=${2:-y} ans
  read -rp "  $q [$( [[ $def == y ]] && echo Y/n || echo y/N )] " ans </dev/tty || true
  ans=${ans:-$def}
  [[ ${ans,,} == y* ]]
}

# NOTE: must not pipe an infinite stream into head under pipefail (SIGPIPE
# would trip the ERR trap) — read a finite chunk instead. Same idiom as
# install.sh's gen_secret.
gen_secret() { local s; s=$(head -c 1024 /dev/urandom | tr -dc 'A-Za-z0-9'); printf '%s' "${s:0:$1}"; }

# Percent-encode a value for safe use inside a smtp://user:pass@host URL —
# SMTP passwords routinely contain '@', ':', '/', etc. that would otherwise
# break the URL's own delimiters.
urlencode() {
  local s=$1 out='' i c
  for (( i = 0; i < ${#s}; i++ )); do
    c=${s:i:1}
    case $c in
      [a-zA-Z0-9.~_-]) out+=$c ;;
      *) printf -v hex '%%%02X' "'$c"; out+=$hex ;;
    esac
  done
  printf '%s' "$out"
}

valid_domain() { [[ $1 =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || { warn "'$1' doesn't look like a domain (use lowercase, e.g. errors.example.com)"; return 1; }; }

# ---------------------------------------------------------------------------
# Answers persistence — a small copy of install.sh's save_conf/ask_conf, but
# scoped to this script's OWN conf file so removing GlitchTip never touches
# install.sh's install.conf.
# ---------------------------------------------------------------------------
save_gt_conf() { # save_gt_conf VAR VALUE
  local key=$1 val=$2
  touch "$GT_CONF_FILE"; chmod 600 "$GT_CONF_FILE"
  grep -v "^${key}=" "$GT_CONF_FILE" >"$GT_CONF_FILE.tmp" 2>/dev/null || true
  printf '%s=%q\n' "$key" "$val" >>"$GT_CONF_FILE.tmp"
  mv "$GT_CONF_FILE.tmp" "$GT_CONF_FILE"
}

ask_gt_conf() { # ask_gt_conf VAR "prompt" "default" [validator]
  local var=$1 prompt=$2 def=${3:-} validator=${4:-}
  if [[ -n ${!var:-} ]]; then
    info "$prompt: ${!var} (saved)"
    return 0
  fi
  local val
  while true; do
    read -rp "  ${C_BLD}$prompt${C_OFF} [$def]: " val </dev/tty
    val=${val:-$def}
    val=${val//$'\r'/}
    val=${val#"${val%%[![:space:]]*}"}
    val=${val%"${val##*[![:space:]]}"}
    [[ -z $val ]] && { warn "A value is required."; continue; }
    if [[ -n $validator ]] && ! "$validator" "$val"; then continue; fi
    printf -v "$var" '%s' "$val"
    save_gt_conf "$var" "$val"
    return 0
  done
}

# ---------------------------------------------------------------------------
# Preflight — reuse install.sh's answers, refuse to guess anything Cloudflare
# ---------------------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "Run as root."
[[ -f $CONF_FILE ]] || die "$CONF_FILE not found — run install.sh first."
[[ -f $CF_INI ]] || die "$CF_INI not found — run install.sh first (it writes this for certbot's Cloudflare DNS-01 plugin)."
command -v docker >/dev/null 2>&1 || die "docker not found — run install.sh first."
command -v certbot >/dev/null 2>&1 || die "certbot not found — run install.sh first."
command -v nginx >/dev/null 2>&1 || die "nginx not found — run install.sh first."

# shellcheck source=/dev/null
source "$CONF_FILE"
for v in CF_API_TOKEN CF_ZONE PUBLIC_IP LE_EMAIL; do
  [[ -n ${!v:-} ]] || die "$v missing from $CONF_FILE — re-run install.sh's interview phase (bash install.sh --redo interview)."
done
# shellcheck source=/dev/null
[[ -f $GT_CONF_FILE ]] && { chmod 600 "$GT_CONF_FILE"; source "$GT_CONF_FILE"; }

step "Phase 1/6 — Subdomain"
info "Answer is saved to $GT_CONF_FILE (root-only) — re-runs will not ask again."
ask_gt_conf GT_DOMAIN "GlitchTip subdomain" "errors.invenpro.app" valid_domain
ok "GlitchTip will be served at https://$GT_DOMAIN"

# ---------------------------------------------------------------------------
# Phase 2/6 — Cloudflare DNS A record (same cf_upsert_a idiom as install.sh)
# ---------------------------------------------------------------------------
cf_api() { # cf_api METHOD path [json]
  curl -fsS -m 20 -X "$1" "https://api.cloudflare.com/client/v4/$2" \
    -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
    ${3:+--data "$3"}
}

cf_upsert_a() { # cf_upsert_a fqdn ip
  local fqdn=$1 ip=$2 rec_id
  rec_id=$(cf_api GET "zones/$CF_ZONE_ID/dns_records?type=A&name=$fqdn" | jq -r '.result[0].id // empty')
  local body
  body=$(jq -n --arg name "$fqdn" --arg ip "$ip" \
    '{type:"A", name:$name, content:$ip, ttl:300, proxied:false}')
  if [[ -n $rec_id ]]; then
    cf_api PUT "zones/$CF_ZONE_ID/dns_records/$rec_id" "$body" >/dev/null
    info "updated  A  $fqdn -> $ip"
  else
    cf_api POST "zones/$CF_ZONE_ID/dns_records" "$body" >/dev/null
    info "created  A  $fqdn -> $ip"
  fi
}

step "Phase 2/6 — Cloudflare DNS"
if [[ -z ${CF_ZONE_ID:-} ]]; then
  CF_ZONE_ID=$(cf_api GET "zones?name=$CF_ZONE" | jq -r '.result[0].id // empty') || CF_ZONE_ID=""
fi
if [[ -z $CF_ZONE_ID ]]; then
  warn "Zone '$CF_ZONE' not found with this token. Create this A record YOURSELF:"
  warn "  $GT_DOMAIN  ->  $PUBLIC_IP   (DNS only / grey cloud)"
  confirm "Record created (or will be) — continue?" || exit 1
else
  cf_upsert_a "$GT_DOMAIN" "$PUBLIC_IP"
  ok "DNS record in place (grey-cloud / DNS-only)"
fi

# ---------------------------------------------------------------------------
# Phase 3/6 — Let's Encrypt cert, SEPARATE cert-name so it never interacts
# with the main 4-domain "inventorypro" cert's renewal/lifecycle.
# ---------------------------------------------------------------------------
step "Phase 3/6 — Let's Encrypt certificate"
info "Requesting certificate for $GT_DOMAIN (DNS-01, cert-name=$CERT_NAME)…"
certbot certonly --non-interactive --agree-tos -m "$LE_EMAIL" \
  --dns-cloudflare --dns-cloudflare-credentials "$CF_INI" \
  --dns-cloudflare-propagation-seconds 60 \
  --cert-name "$CERT_NAME" \
  -d "$GT_DOMAIN" \
  >>"$LOG_FILE" 2>&1 || { err "certbot failed — tail of log:"; tail -20 "$LOG_FILE" >&2; exit 1; }
# install.sh's certbot.timer + reload-nginx.sh deploy hook already renews
# and reloads for EVERY cert-name on the box, including this new one — no
# extra hook/timer needed here.
systemctl enable --now certbot.timer >>"$LOG_FILE" 2>&1 || true
ok "Certificate issued: $CERT_DIR (auto-renews via the existing certbot.timer)"

# ---------------------------------------------------------------------------
# Phase 4/6 — Secrets + env file (chmod 600, own file — never folded into
# the main app's .env, mirroring the healthchecks.env separation precedent)
# ---------------------------------------------------------------------------
step "Phase 4/6 — Secrets"
if [[ -z ${GT_POSTGRES_PASSWORD:-} ]]; then
  GT_POSTGRES_PASSWORD=$(gen_secret 32); save_gt_conf GT_POSTGRES_PASSWORD "$GT_POSTGRES_PASSWORD"
  info "Generated dedicated Postgres password (32 chars)"
fi
if [[ -z ${GT_SECRET_KEY:-} ]]; then
  GT_SECRET_KEY=$(gen_secret 64); save_gt_conf GT_SECRET_KEY "$GT_SECRET_KEY"
  info "Generated Django SECRET_KEY (64 chars)"
fi

# Reuse the main app's SMTP if install.sh's interview configured it — .env
# is compose-format, not valid bash (SMTP_FROM has unquoted spaces/<>), so
# pluck keys rather than sourcing it, same discipline as setup-backups.sh.
env_get() { grep -m1 "^$1=" "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2-; }
SMTP_HOST_MAIN=$(env_get SMTP_HOST)
if [[ -n $SMTP_HOST_MAIN ]]; then
  smtp_user=$(urlencode "$(env_get SMTP_USER)")
  smtp_pass=$(urlencode "$(env_get SMTP_PASS)")
  smtp_port=$(env_get SMTP_PORT); smtp_port=${smtp_port:-587}
  GT_EMAIL_URL="smtp://${smtp_user}:${smtp_pass}@${SMTP_HOST_MAIN}:${smtp_port}"
  info "Reusing the main app's SMTP for GlitchTip's outbound email"
else
  GT_EMAIL_URL="consolemail://"
  warn "No SMTP configured on this VPS — GlitchTip emails (invites, password resets) log to the container only, no real email is sent."
fi

cat >"$GT_ENV_FILE" <<EOF
# Generated by setup-glitchtip.sh $(date -Is) — DO NOT commit. chmod 600.
POSTGRES_DB=glitchtip
POSTGRES_USER=glitchtip
POSTGRES_PASSWORD=$GT_POSTGRES_PASSWORD

SECRET_KEY=$GT_SECRET_KEY
GLITCHTIP_DOMAIN=https://$GT_DOMAIN
DEFAULT_FROM_EMAIL=glitchtip@$CF_ZONE
EMAIL_URL=$GT_EMAIL_URL

# Closed single-org instance: leave registration OPEN for the very first
# afternoon sign-up (see docs/GLITCHTIP.md), then flip both to False and
# re-run the compose "up -d" below to close it — the intended access gate
# is "closed registration + this being the only account", not a firewall.
ENABLE_USER_REGISTRATION=True
ENABLE_ORGANIZATION_CREATION=True

WEB_PORT=$GT_WEB_PORT
EOF
chmod 600 "$GT_ENV_FILE"
ok "Wrote $GT_ENV_FILE (600)"

# ---------------------------------------------------------------------------
# Phase 5/6 — Compose stack: web + worker + redis-compatible broker (Valkey)
# + a DEDICATED Postgres, its own compose project, own network, own volumes.
# ---------------------------------------------------------------------------
step "Phase 5/6 — Compose stack"
cat >"$GT_COMPOSE_FILE" <<'EOF'
# InventoryPro — GlitchTip (#213), generated by setup-glitchtip.sh.
# Deliberately its OWN compose project (inventorypro-glitchtip) — isolated
# network, isolated Postgres, isolated volumes. Nothing here shares the main
# app's postgres container or setup-backups.sh's dump lifecycle (accepted
# tradeoff — see docs/GLITCHTIP.md "Backup coverage").
x-environment: &default-environment
  DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
  VALKEY_URL: redis://redis:6379
  SECRET_KEY: ${SECRET_KEY}
  EMAIL_URL: ${EMAIL_URL}
  DEFAULT_FROM_EMAIL: ${DEFAULT_FROM_EMAIL}
  GLITCHTIP_DOMAIN: ${GLITCHTIP_DOMAIN}
  ENABLE_USER_REGISTRATION: ${ENABLE_USER_REGISTRATION:-False}
  ENABLE_ORGANIZATION_CREATION: ${ENABLE_ORGANIZATION_CREATION:-False}
  ALLOWED_HOSTS: "*"
  CSRF_TRUSTED_ORIGINS: ${GLITCHTIP_DOMAIN}

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - glitchtip_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: valkey/valkey:9
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  # SERVER_ROLE=web (the image's default) runs Django's migrations THEN the
  # app server on every boot — no separate one-shot migrate service needed.
  # worker's `condition: service_healthy` on web (below) means the worker
  # never starts before migrations have already completed.
  web:
    image: glitchtip/glitchtip:6
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      <<: *default-environment
      SERVER_ROLE: web
    ports:
      - "127.0.0.1:${WEB_PORT:-8090}:8000"
    volumes:
      - glitchtip_uploads:/code/uploads
    healthcheck:
      # No documented GlitchTip health endpoint — a plain TCP/HTTP GET on
      # the app port via python3 (always present in the image) is enough to
      # prove gunicorn is up and migrations finished without needing curl.
      test: ["CMD-SHELL", "python3 -c \"import urllib.request; urllib.request.urlopen('http://localhost:8000/', timeout=3)\" || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 5
      start_period: 30s

  worker:
    image: glitchtip/glitchtip:6
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      web:
        condition: service_healthy
    environment:
      <<: *default-environment
      SERVER_ROLE: worker
    volumes:
      - glitchtip_uploads:/code/uploads

volumes:
  glitchtip_pgdata:
  glitchtip_uploads:
EOF
ok "Wrote $GT_COMPOSE_FILE"

# --- sizing check, BEFORE starting anything -------------------------------
# Budget: ~256-512MB is GlitchTip's own quoted target for its minimal
# single-container "all_in_one" mode. This is the split web+worker shape
# instead (2 always-on Python processes) plus a SECOND Postgres and a
# SECOND Valkey instance layered on top of whatever the main InventoryPro
# stack is already using — so the warning threshold is set noticeably
# higher than GlitchTip's own minimal number, not copied from it.
GT_MEM_WARN_MB=1024
avail_mb=$(free -m | awk '/^Mem:/{print $7}')
if [[ -n $avail_mb ]] && (( avail_mb < GT_MEM_WARN_MB )); then
  warn "Only ${avail_mb}MiB RAM available right now — GlitchTip's stack (Postgres + Valkey + web + worker, on top of the running InventoryPro stack) typically wants at least ${GT_MEM_WARN_MB}MiB free headroom."
  warn "Low memory can wedge migrations mid-run or get a container OOM-killed. Consider upsizing the VPS first."
  confirm "Continue starting GlitchTip anyway?" n || { info "Nothing was started. Re-run this script any time — everything above is already saved."; exit 1; }
else
  ok "Memory check: ${avail_mb:-?}MiB available (>= ${GT_MEM_WARN_MB}MiB threshold)"
fi

info "Pulling images and starting the GlitchTip stack (first run also applies Django's own DB migrations — can take a minute)…"
$GT_COMPOSE up -d >>"$LOG_FILE" 2>&1 || { err "docker compose up failed — tail of log:"; tail -40 "$LOG_FILE" >&2; exit 1; }

info "Waiting for the web container to become healthy…"
n=0
until $GT_COMPOSE ps --format json web 2>/dev/null | grep -q '"Health":"healthy"'; do
  n=$((n + 1))
  if (( n > 60 )); then
    err "GlitchTip web did not become healthy after 5 minutes. Recent logs:"
    $GT_COMPOSE logs --tail 50 web >&2
    exit 1
  fi
  sleep 5
done
ok "GlitchTip stack is up (web healthy — migrations applied)"

# ---------------------------------------------------------------------------
# Phase 6/6 — Host nginx vhost on the existing TLS edge
# ---------------------------------------------------------------------------
step "Phase 6/6 — nginx vhost"
[[ -f /etc/nginx/conf.d/inventorypro-map.conf ]] || cat >/etc/nginx/conf.d/inventorypro-map.conf <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
EOF

ngx_ver=$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
HTTP2_LISTEN="" HTTP2_DIRECTIVE="    http2 on;"
if [[ $(printf '%s\n' "$ngx_ver" 1.25 | sort -V | head -1) != 1.25 ]]; then
  HTTP2_LISTEN=" http2" HTTP2_DIRECTIVE=""
fi

cat >"/etc/nginx/sites-available/inventorypro-glitchtip.conf" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $GT_DOMAIN;
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl$HTTP2_LISTEN;
    listen [::]:443 ssl$HTTP2_LISTEN;
$HTTP2_DIRECTIVE
    server_name $GT_DOMAIN;
    ssl_certificate     $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    # Crash/event payloads and source maps can run larger than typical API
    # requests — GlitchTip's own docs recommend 40M.
    client_max_body_size 40m;

    location / {
        proxy_pass http://127.0.0.1:$GT_WEB_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
EOF
ln -sf "/etc/nginx/sites-available/inventorypro-glitchtip.conf" \
       "/etc/nginx/sites-enabled/inventorypro-glitchtip.conf"

nginx -t >>"$LOG_FILE" 2>&1 || { err "nginx config test failed:"; nginx -t; exit 1; }
systemctl reload nginx
ok "nginx serving https://$GT_DOMAIN -> 127.0.0.1:$GT_WEB_PORT"

echo
echo "${C_BLD}${C_GRN}════════════════════════════════════════════════════════════════${C_OFF}"
echo "${C_BLD}${C_GRN}  GlitchTip is up: https://$GT_DOMAIN${C_OFF}"
echo "${C_BLD}${C_GRN}════════════════════════════════════════════════════════════════${C_OFF}"
cat <<EOF

  YOUR checklist — do these now:
  1. Open https://$GT_DOMAIN and sign up as the first (and only) user.
  2. Create your Organization, then a Project — pick "React Native" (or
     "Sentry" generic) as the project platform.
  3. Settings -> that project -> "SDK Setup" / Client Keys (DSN) — copy the
     DSN shown. It looks like https://<key>@$GT_DOMAIN/<project-id>.
  4. That DSN is EXPO_PUBLIC_SENTRY_DSN for #213's mobile Sentry client
     (GlitchTip speaks the Sentry protocol, so the stock @sentry/react-native
     SDK works against it unmodified) — paste it into apps/mobile/eas.json's
     preview/production env blocks and any local release-build env. Leave
     it unset for Metro/dev builds (Sentry stays fully inert without a DSN).
  5. RECOMMENDED once your account exists: close registration — edit
     $GT_ENV_FILE, set ENABLE_USER_REGISTRATION=False and
     ENABLE_ORGANIZATION_CREATION=False, then:
       $GT_COMPOSE up -d
     This instance has no other access gate — closed registration + being
     the only account IS the intended security boundary (see requirement).

  Day-2:
      $GT_COMPOSE ps                     status
      $GT_COMPOSE logs -f web worker      logs
      $GT_COMPOSE up -d                   apply an .env change
      docs/GLITCHTIP.md                   full reference + removal steps
EOF
