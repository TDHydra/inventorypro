#!/usr/bin/env bash
#
# InventoryPro VPS installer — Ubuntu 24.04/26.04, Debian 12/13
# ================================================================
# Run as root on a FRESH VPS:
#
#     scp infra/vps/install.sh root@<vps-ip>:
#     ssh root@<vps-ip> bash install.sh
#
# What you get:
#   * Docker (official repo) running the InventoryPro prod stack
#     (Postgres + MinIO + API + Web), every port bound to 127.0.0.1 only
#   * Host nginx as the TLS edge, Let's Encrypt via Cloudflare DNS-01
#     (auto-renews; works even with orange-cloud proxying)
#   * A records created for you through the Cloudflare API (optional)
#   * WireGuard management tunnel — MinIO console + (after lockdown) SSH
#     are reachable ONLY through it
#   * UFW: public internet sees 80, 443 and the WireGuard UDP port; SSH
#     stays public until YOU confirm WG works, then finalize-lockdown.sh
#   * healthchecks.io monitoring from a 1-minute systemd timer
#     (API /health, web, MinIO, Postgres, disk space, cert expiry)
#   * Generated secrets (DB / MinIO / JWT) saved to a root-only
#     credentials file and printed once at the end
#
# The script is IDEMPOTENT: it asks all questions up front, remembers your
# answers, and re-running it resumes from the phase that failed.
#
#   bash install.sh              run / resume
#   bash install.sh --phases     list phases and their status
#   bash install.sh --redo NAME  clear one phase's done-marker, then resume
#   bash install.sh --reset      forget all phase markers (answers are kept)
#
set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Constants & paths
# ---------------------------------------------------------------------------
INSTALL_DIR=/opt/inventorypro
APP_DIR=$INSTALL_DIR/app
BIN_DIR=$INSTALL_DIR/bin
WG_DIR=$INSTALL_DIR/wireguard
STATE_DIR=$INSTALL_DIR/.install-state
CONF_FILE=$INSTALL_DIR/install.conf
ENV_FILE=$INSTALL_DIR/.env
HC_ENV_FILE=$INSTALL_DIR/healthchecks.env
CREDS_FILE=/root/inventorypro-credentials.txt
CF_INI=/root/.secrets/certbot-cloudflare.ini
LOG_FILE=/var/log/inventorypro-install.log
CERT_NAME=inventorypro
CERT_DIR=/etc/letsencrypt/live/$CERT_NAME

WG_IF=wg0
WG_SUBNET=10.8.0.0/24
WG_SERVER_IP=10.8.0.1

# Local (loopback-only) ports the containers publish; nginx proxies to these.
PORT_API=3000
PORT_WEB=8088
PORT_S3=9000
PORT_CONSOLE=9001

COMPOSE="docker compose --project-name inventorypro --env-file $ENV_FILE -f $APP_DIR/infra/docker-compose.prod.yml -f $INSTALL_DIR/compose.vps.yml"

PHASES=(preflight interview secrets packages dns certs nginx wireguard firewall app monitoring helpers summary)
CURRENT_PHASE=startup

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RED=$'\e[31m' C_GRN=$'\e[32m' C_YEL=$'\e[33m' C_BLU=$'\e[34m' C_BLD=$'\e[1m' C_OFF=$'\e[0m'
else
  C_RED='' C_GRN='' C_YEL='' C_BLU='' C_BLD='' C_OFF=''
fi

log()  { printf '%s\n' "$*" >>"$LOG_FILE"; }
info() { printf '%s\n'  "  $*";                    log "INFO  $*"; }
ok()   { printf '%s\n'  "${C_GRN}  ✔ $*${C_OFF}";  log "OK    $*"; }
warn() { printf '%s\n'  "${C_YEL}  ⚠ $*${C_OFF}";  log "WARN  $*"; }
err()  { printf '%s\n'  "${C_RED}  ✘ $*${C_OFF}" >&2; log "ERROR $*"; }
step() { printf '\n%s\n' "${C_BLD}${C_BLU}==> $*${C_OFF}"; log "STEP  $*"; }
die()  { err "$*"; exit 1; }

on_error() {
  local line=$1
  err "Install failed in phase '${CURRENT_PHASE}' (line $line)."
  err "Full log: $LOG_FILE"
  err "Fix the problem, then RE-RUN this script — completed phases are skipped"
  err "and it resumes at '${CURRENT_PHASE}'. To force a phase to run again:"
  err "    bash $0 --redo ${CURRENT_PHASE}"
  exit 1
}
trap 'on_error $LINENO' ERR

confirm() { # confirm "question" [default-yes]
  local q=$1 def=${2:-y} ans
  read -rp "  $q [$( [[ $def == y ]] && echo Y/n || echo y/N )] " ans </dev/tty || true
  ans=${ans:-$def}
  [[ ${ans,,} == y* ]]
}

# ---------------------------------------------------------------------------
# Config persistence — answers survive re-runs
# ---------------------------------------------------------------------------
save_conf() { # save_conf VAR VALUE
  local key=$1 val=$2
  touch "$CONF_FILE"; chmod 600 "$CONF_FILE"
  grep -v "^${key}=" "$CONF_FILE" >"$CONF_FILE.tmp" 2>/dev/null || true
  printf '%s=%q\n' "$key" "$val" >>"$CONF_FILE.tmp"
  mv "$CONF_FILE.tmp" "$CONF_FILE"
}

ask_conf() { # ask_conf VAR "prompt" "default" [validator] [secret]
  local var=$1 prompt=$2 def=${3:-} validator=${4:-} secret=${5:-}
  if [[ -n ${!var:-} ]]; then
    if [[ -n $secret ]]; then info "$prompt: (saved)"; else info "$prompt: ${!var}"; fi
    return 0
  fi
  local val
  while true; do
    if [[ -n $secret ]]; then
      read -rsp "  ${C_BLD}$prompt${C_OFF}: " val </dev/tty; echo
    elif [[ -n $def ]]; then
      read -rp  "  ${C_BLD}$prompt${C_OFF} [$def]: " val </dev/tty; val=${val:-$def}
    else
      read -rp  "  ${C_BLD}$prompt${C_OFF}: " val </dev/tty
    fi
    # Sanitize pasted input: strip CRs (Windows/PuTTY paste) and outer whitespace.
    val=${val//$'\r'/}
    val=${val#"${val%%[![:space:]]*}"}
    val=${val%"${val##*[![:space:]]}"}
    [[ -z $val ]] && { warn "A value is required."; continue; }
    if [[ -n $validator ]] && ! "$validator" "$val"; then continue; fi
    printf -v "$var" '%s' "$val"
    save_conf "$var" "$val"
    return 0
  done
}

valid_domain() { [[ $1 =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || { warn "'$1' doesn't look like a domain (use lowercase, e.g. api.example.com)"; return 1; }; }
valid_port()   { [[ $1 =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )) || { warn "'$1' is not a valid port"; return 1; }; }
valid_email()  { [[ $1 =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { warn "'$1' doesn't look like an email address"; return 1; }; }

# NOTE: must not pipe an infinite stream into head — under `pipefail` the
# upstream SIGPIPE (exit 141) would trip the ERR trap. Read a finite chunk.
gen_secret() { local s; s=$(head -c 1024 /dev/urandom | tr -dc 'A-Za-z0-9'); printf '%s' "${s:0:$1}"; }

mark_done() { touch "$STATE_DIR/$1.done"; }
is_done()   { [[ -f "$STATE_DIR/$1.done" ]]; }

run_phase() { # run_phase name "title" func
  local name=$1 title=$2 func=$3
  CURRENT_PHASE=$name
  if is_done "$name"; then info "[$name] already done — skipping ($title)"; return 0; fi
  step "$title"
  "$func"
  mark_done "$name"
  ok "$title — done"
}

# ---------------------------------------------------------------------------
# CLI args
# ---------------------------------------------------------------------------
case ${1:-} in
  --help|-h) sed -n '2,40p' "$0"; exit 0 ;;
  --phases)
    for p in "${PHASES[@]}"; do
      printf '  %-12s %s\n' "$p" "$(is_done "$p" 2>/dev/null && echo done || echo pending)"
    done; exit 0 ;;
  --redo)  [[ -n ${2:-} ]] || die "--redo needs a phase name (see --phases)"
           rm -f "$STATE_DIR/$2.done"; echo "  cleared marker for '$2' — re-run the script"; exit 0 ;;
  --reset) rm -rf "$STATE_DIR"; echo "  all phase markers cleared — re-run the script"; exit 0 ;;
  '') ;;
  *) die "unknown option '$1' (try --help)" ;;
esac

# ---------------------------------------------------------------------------
# Phase: preflight
# ---------------------------------------------------------------------------
phase_preflight() {
  [[ $EUID -eq 0 ]] || die "Run as root (sudo -i first)."
  mkdir -p "$INSTALL_DIR" "$STATE_DIR" "$BIN_DIR" "$WG_DIR" /root/.secrets
  chmod 700 "$INSTALL_DIR" "$WG_DIR" /root/.secrets
  touch "$LOG_FILE"; chmod 600 "$LOG_FILE"

  . /etc/os-release
  info "Detected: $PRETTY_NAME"
  command -v apt-get >/dev/null 2>&1 || \
    die "This script needs an apt-based distro (Ubuntu/Debian). Detected: ${PRETTY_NAME:-unknown}.
  The stack itself is plain Docker — on Fedora/RHEL/etc. install Docker, nginx,
  certbot (+ dns-cloudflare plugin), WireGuard and a firewall yourself, then
  follow the phases of this script by hand (see the README's VPS section)."
  case ${ID:-} in
    ubuntu)
      case ${VERSION_ID:-} in
        26.04|24.04) : ;;
        *) warn "Untested Ubuntu version ($VERSION_ID) — built for 26.04/24.04."
           confirm "Continue anyway?" n || exit 1 ;;
      esac ;;
    debian)
      case ${VERSION_ID:-} in
        12|13) : ;;
        *) warn "Untested Debian version (${VERSION_ID:-?}) — built for 12/13."
           confirm "Continue anyway?" n || exit 1 ;;
      esac ;;
    *)
      # Derivatives (Mint, Pop!_OS, …) usually work via their upstream base.
      warn "Untested distro '$ID' — tested on Ubuntu 24.04/26.04 and Debian 12/13."
      warn "apt is present so it will probably work; Docker packages come from"
      warn "the upstream base (${ID_LIKE:-ubuntu})."
      confirm "Continue anyway?" n || exit 1 ;;
  esac

  info "Installing base tools (curl, jq, git, openssl, dnsutils)…"
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
  apt-get update -qq >>"$LOG_FILE" 2>&1
  apt-get install -y -qq curl jq git openssl ca-certificates gnupg dnsutils >>"$LOG_FILE" 2>&1

  PUBLIC_IP=$(curl -4 -fsS -m 10 https://api.ipify.org || true)
  [[ -n $PUBLIC_IP ]] || die "Could not detect the server's public IPv4 (is outbound internet up?)"
  save_conf PUBLIC_IP "$PUBLIC_IP"
  ok "Public IP: $PUBLIC_IP"
}

# ---------------------------------------------------------------------------
# Phase: interview — every question is asked HERE, then the rest runs hands-off
# ---------------------------------------------------------------------------
verify_cf_token() {
  # Both token types work here and with certbot: legacy user tokens (40 chars)
  # and account-owned tokens (cfat_… prefix). We do NOT use /user/tokens/verify
  # because it rejects account tokens — instead we test the thing we actually
  # need: can this token see (and edit DNS in) the zone?
  local token=$1 resp code body
  # The prompt is hidden, so show a masked preview — makes paste mishaps visible.
  info "Received a ${#token}-character value beginning '${token:0:5}…' — checking access to zone '$CF_ZONE'…"
  if [[ $token =~ ^[0-9a-f]{37}$ ]]; then
    warn "This looks like the GLOBAL API KEY (37 hex chars) — it will NOT work."
    warn "Create an API token instead: dash.cloudflare.com -> API Tokens ->"
    warn "'Edit zone DNS' template -> zone '$CF_ZONE'."
    return 1
  fi
  if ! resp=$(curl -sS -m 15 -w $'\n%{http_code}' \
        "https://api.cloudflare.com/client/v4/zones?name=$CF_ZONE" \
        -H "Authorization: Bearer $token" 2>&1); then
    warn "Network problem reaching api.cloudflare.com: $resp"
    warn "(check outbound HTTPS / DNS on this VPS: curl -v https://api.cloudflare.com)"
    return 1
  fi
  code=${resp##*$'\n'}
  body=${resp%$'\n'*}
  if [[ $(jq -r '.success // false' <<<"$body" 2>/dev/null) != true ]]; then
    warn "Cloudflare rejected the token (HTTP $code): $(jq -r '[.errors[]?.message] | join("; ")' <<<"$body" 2>/dev/null || printf '%s' "$body")"
    return 1
  fi
  if [[ $(jq -r '.result | length' <<<"$body") == 0 ]]; then
    warn "The token is VALID but cannot see zone '$CF_ZONE'."
    warn "Re-scope it to that zone (Zone / DNS / Edit), or check the zone spelling."
    return 1
  fi
  local perms
  perms=$(jq -r '(.result[0].permissions // []) | join(",")' <<<"$body" 2>/dev/null)
  if [[ -n $perms && $perms != *"#dns_records:edit"* ]]; then
    warn "The token sees '$CF_ZONE' but lacks DNS edit permission — certbot's"
    warn "DNS-01 challenge will fail. Give it Zone / DNS / Edit."
    return 1
  fi
  ok "Token can see zone '$CF_ZONE' with DNS edit permission"
}

phase_interview() {
  info "Answer everything once — answers are saved to $CONF_FILE (root-only)"
  info "and re-runs will not ask again."
  echo

  info "${C_BLD}— Domains (create them all in the SAME Cloudflare zone) —${C_OFF}"
  ask_conf API_DOMAIN   "API domain (Fastify)"            "api.example.com"   valid_domain
  ask_conf WEB_DOMAIN   "Frontend domain (Expo web app)"  "app.example.com"   valid_domain
  ask_conf S3_DOMAIN    "S3 domain (MinIO API — media)"   "s3.example.com"    valid_domain
  ask_conf MINIO_DOMAIN "MinIO admin-console domain (WireGuard-only)" "minio.example.com" valid_domain
  local zone_guess
  zone_guess=$(awk -F. '{print $(NF-1)"."$NF}' <<<"$API_DOMAIN")
  ask_conf CF_ZONE "Cloudflare zone (registered domain)" "$zone_guess" valid_domain

  echo
  info "${C_BLD}— Cloudflare —${C_OFF}"
  info "Create an API token at https://dash.cloudflare.com/profile/api-tokens"
  info "with permission  Zone / DNS / Edit  on zone '$CF_ZONE'."
  info "(Account-owned tokens ('cfat_…') and classic user tokens both work.)"
  while true; do
    ask_conf CF_API_TOKEN "Cloudflare API token" "" "" secret
    verify_cf_token "$CF_API_TOKEN" && { ok "Cloudflare token verified"; break; }
    CF_API_TOKEN=""   # force re-ask
  done

  echo
  info "${C_BLD}— Let's Encrypt —${C_OFF}"
  ask_conf LE_EMAIL "Email for Let's Encrypt expiry notices" "" valid_email

  echo
  info "${C_BLD}— Database —${C_OFF}"
  ask_conf POSTGRES_DB   "Postgres database name" "inventorypro"
  ask_conf POSTGRES_USER "Postgres user"          "inventorypro"
  info "(the password is generated for you in the next phase)"

  echo
  info "${C_BLD}— MinIO —${C_OFF}"
  ask_conf MINIO_ROOT_USER "MinIO root user"   "inventorypro-admin"
  ask_conf MINIO_BUCKET    "MinIO media bucket" "inventorypro-media"

  echo
  info "${C_BLD}— SMTP (outbound mail; the API degrades to no-op without it) —${C_OFF}"
  if [[ -z ${SMTP_ENABLED:-} ]]; then
    if confirm "Configure SMTP now?"; then SMTP_ENABLED=yes; else SMTP_ENABLED=no; fi
    save_conf SMTP_ENABLED "$SMTP_ENABLED"
  fi
  if [[ $SMTP_ENABLED == yes ]]; then
    ask_conf SMTP_HOST "SMTP host" ""
    ask_conf SMTP_PORT "SMTP port (465 = implicit TLS, else STARTTLS)" "587" valid_port
    ask_conf SMTP_USER "SMTP username" ""
    ask_conf SMTP_PASS "SMTP password" "" "" secret
    ask_conf SMTP_FROM "From header" "Inventory Pro <no-reply@$CF_ZONE>"
  else
    warn "Skipping SMTP — password-reset / invite emails will be silently disabled."
  fi

  echo
  info "${C_BLD}— App source —${C_OFF}"
  ask_conf GIT_REPO_URL "Git repo URL (https URL; for a private repo embed a PAT or add a deploy key first)" \
           "https://github.com/TDHydra/inventorypro.git"
  ask_conf GIT_BRANCH "Branch to deploy" "main"

  echo
  info "${C_BLD}— Monitoring (healthchecks.io) —${C_OFF}"
  if [[ -z ${HC_MODE:-} ]]; then
    info "With a healthchecks.io PROJECT API key I can create the 6 checks for you"
    info "(api, web, minio, postgres, disk, tls). Find it under Project Settings → API access."
    if confirm "Do you have a healthchecks.io API key?"; then HC_MODE=api; else
      if confirm "Use a single manual heartbeat ping URL instead?"; then HC_MODE=manual; else HC_MODE=off; fi
    fi
    save_conf HC_MODE "$HC_MODE"
  fi
  case $HC_MODE in
    api)    ask_conf HC_API_KEY "healthchecks.io project API key" "" "" secret ;;
    manual) ask_conf HC_HEARTBEAT_URL "Heartbeat ping URL (https://hc-ping.com/…)" "" ;;
    off)    warn "Monitoring pings disabled — the local health timer still runs and logs." ;;
  esac

  echo
  info "${C_BLD}— WireGuard —${C_OFF}"
  ask_conf WG_PORT "WireGuard UDP port" "51820" valid_port
  ask_conf WG_CLIENT_NAMES "Client device names (comma-separated)" "laptop,phone"

  echo
  ok "Interview complete. Everything from here on is unattended."
}

# ---------------------------------------------------------------------------
# Phase: secrets
# ---------------------------------------------------------------------------
phase_secrets() {
  if [[ -z ${POSTGRES_PASSWORD:-} ]]; then
    POSTGRES_PASSWORD=$(gen_secret 32);  save_conf POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
    info "Generated Postgres password (32 chars)"
  fi
  if [[ -z ${MINIO_ROOT_PASSWORD:-} ]]; then
    MINIO_ROOT_PASSWORD=$(gen_secret 32); save_conf MINIO_ROOT_PASSWORD "$MINIO_ROOT_PASSWORD"
    info "Generated MinIO root password (32 chars)"
  fi
  if [[ -z ${JWT_SECRET:-} ]]; then
    JWT_SECRET=$(gen_secret 64);          save_conf JWT_SECRET "$JWT_SECRET"
    info "Generated JWT secret (64 chars)"
  fi

  cat >"$ENV_FILE" <<EOF
# Generated by install.sh $(date -Is) — DO NOT commit. chmod 600.
POSTGRES_DB=$POSTGRES_DB
POSTGRES_USER=$POSTGRES_USER
POSTGRES_PASSWORD=$POSTGRES_PASSWORD

MINIO_ROOT_USER=$MINIO_ROOT_USER
MINIO_ROOT_PASSWORD=$MINIO_ROOT_PASSWORD
MINIO_BUCKET=$MINIO_BUCKET
MINIO_PUBLIC_ENDPOINT=https://$S3_DOMAIN
MINIO_CONSOLE_URL=https://$MINIO_DOMAIN

JWT_SECRET=$JWT_SECRET
PUBLIC_MEDIA_URL=https://$S3_DOMAIN/$MINIO_BUCKET
CORS_ORIGINS=https://$WEB_DOMAIN
# nginx reaches the containers over the docker bridge — trust that subnet
TRUST_PROXY=172.16.0.0/12

SMTP_HOST=${SMTP_HOST:-}
SMTP_PORT=${SMTP_PORT:-587}
SMTP_USER=${SMTP_USER:-}
SMTP_PASS=${SMTP_PASS:-}
SMTP_FROM=${SMTP_FROM:-}

EXPO_PUBLIC_API_URL=https://$API_DOMAIN
EOF
  chmod 600 "$ENV_FILE"
  ok "Wrote $ENV_FILE (600)"

  write_creds_file
  ok "Credentials saved to $CREDS_FILE (root-only) — full copy printed at the end"
}

write_creds_file() {
  cat >"$CREDS_FILE" <<EOF
InventoryPro VPS credentials — generated $(date -Is)
KEEP THIS FILE SAFE. It is chmod 600, readable by root only.
====================================================================

URLs
  Frontend        https://$WEB_DOMAIN
  API             https://$API_DOMAIN   (health: /health)
  S3 / media      https://$S3_DOMAIN
  MinIO console   https://$MINIO_DOMAIN   <-- WireGuard-only

Postgres (inside docker network only — never exposed publicly)
  database  $POSTGRES_DB
  user      $POSTGRES_USER
  password  $POSTGRES_PASSWORD
  from the VPS:  $COMPOSE exec postgres psql -U $POSTGRES_USER $POSTGRES_DB

MinIO
  root user      $MINIO_ROOT_USER
  root password  $MINIO_ROOT_PASSWORD
  bucket         $MINIO_BUCKET

API
  JWT_SECRET  $JWT_SECRET

WireGuard
  server   $WG_SERVER_IP ($WG_IF), UDP port $WG_PORT
  clients  $WG_DIR/<name>.conf  (QR: qrencode -t ansiutf8 < file)

Files
  env file      $ENV_FILE
  answers       $CONF_FILE
  compose       $APP_DIR/infra/docker-compose.prod.yml + $INSTALL_DIR/compose.vps.yml
  helpers       $BIN_DIR/{upgrade,status,add-wg-client,finalize-lockdown}.sh
EOF
  chmod 600 "$CREDS_FILE"
}

# ---------------------------------------------------------------------------
# Phase: packages — docker, nginx, certbot, wireguard, ufw
# ---------------------------------------------------------------------------
phase_packages() {
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

  info "Installing nginx, certbot (+Cloudflare DNS plugin), WireGuard, UFW, qrencode…"
  apt-get install -y -qq nginx certbot python3-certbot-dns-cloudflare \
    wireguard qrencode ufw >>"$LOG_FILE" 2>&1

  if command -v docker >/dev/null 2>&1; then
    info "Docker already installed: $(docker --version)"
  else
    info "Installing Docker from download.docker.com…"
    install -m 0755 -d /etc/apt/keyrings
    . /etc/os-release
    # Docker publishes separate repos per distro; derivatives use their base.
    local docker_distro=$ID codename=${VERSION_CODENAME:-}
    case $ID in
      ubuntu|debian) : ;;
      *) docker_distro=$( [[ ${ID_LIKE:-} == *debian* ]] && echo debian || echo ubuntu )
         codename=${UBUNTU_CODENAME:-${DEBIAN_CODENAME:-$codename}} ;;
    esac
    curl -fsSL "https://download.docker.com/linux/$docker_distro/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    # Docker's repo can lag a brand-new release — fall back to the latest
    # stable pocket if this codename isn't published yet.
    if ! curl -fsS -o /dev/null "https://download.docker.com/linux/$docker_distro/dists/$codename/Release"; then
      local fallback=$( [[ $docker_distro == debian ]] && echo bookworm || echo noble )
      warn "Docker repo has no '$codename' pocket yet — using '$fallback' packages."
      codename=$fallback
    fi
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$docker_distro $codename stable" \
      >/etc/apt/sources.list.d/docker.list
    apt-get update -qq >>"$LOG_FILE" 2>&1
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >>"$LOG_FILE" 2>&1
  fi
  systemctl enable --now docker >>"$LOG_FILE" 2>&1
  docker compose version >>"$LOG_FILE" 2>&1 || die "docker compose plugin missing"
  ok "Docker: $(docker --version | cut -d, -f1); $(docker compose version | head -1)"
}

# ---------------------------------------------------------------------------
# Phase: dns — upsert A records via the Cloudflare API
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

phase_dns() {
  info "Looking up Cloudflare zone '$CF_ZONE'…"
  CF_ZONE_ID=$(cf_api GET "zones?name=$CF_ZONE" | jq -r '.result[0].id // empty') || CF_ZONE_ID=""
  if [[ -z ${CF_ZONE_ID:-} ]]; then
    warn "Zone '$CF_ZONE' not found with this token. Create these A records YOURSELF:"
    warn "  $API_DOMAIN  / $WEB_DOMAIN / $S3_DOMAIN  ->  $PUBLIC_IP   (DNS only / grey cloud)"
    warn "  $MINIO_DOMAIN  ->  $WG_SERVER_IP   (yes, the private WireGuard IP)"
    confirm "Records created (or will be) — continue?" || exit 1
    return 0
  fi
  save_conf CF_ZONE_ID "$CF_ZONE_ID"
  cf_upsert_a "$API_DOMAIN"   "$PUBLIC_IP"
  cf_upsert_a "$WEB_DOMAIN"   "$PUBLIC_IP"
  cf_upsert_a "$S3_DOMAIN"    "$PUBLIC_IP"
  # Management plane: the console domain resolves to the WireGuard server IP,
  # so it simply does not exist for anyone outside the tunnel.
  cf_upsert_a "$MINIO_DOMAIN" "$WG_SERVER_IP"
  ok "DNS records in place (grey-cloud / DNS-only; orange-cloud $WEB_DOMAIN/$API_DOMAIN later if you like — NOT $S3_DOMAIN, uploads would hit Cloudflare's body-size cap)"
}

# ---------------------------------------------------------------------------
# Phase: certs — one multi-SAN cert via DNS-01 (no port 80 needed, ever)
# ---------------------------------------------------------------------------
phase_certs() {
  cat >"$CF_INI" <<EOF
dns_cloudflare_api_token = $CF_API_TOKEN
EOF
  chmod 600 "$CF_INI"

  info "Requesting Let's Encrypt certificate for all 4 domains (DNS-01)…"
  certbot certonly --non-interactive --agree-tos -m "$LE_EMAIL" \
    --dns-cloudflare --dns-cloudflare-credentials "$CF_INI" \
    --dns-cloudflare-propagation-seconds 60 \
    --cert-name "$CERT_NAME" \
    -d "$API_DOMAIN" -d "$WEB_DOMAIN" -d "$S3_DOMAIN" -d "$MINIO_DOMAIN" \
    >>"$LOG_FILE" 2>&1 || { err "certbot failed — tail of log:"; tail -20 "$LOG_FILE" >&2; return 1; }

  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  cat >/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/usr/bin/env bash
systemctl reload nginx
EOF
  chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
  systemctl enable --now certbot.timer >>"$LOG_FILE" 2>&1 || true
  ok "Certificate issued: $CERT_DIR (auto-renews via certbot.timer + nginx reload hook)"
}

# ---------------------------------------------------------------------------
# Phase: nginx — vhosts
# ---------------------------------------------------------------------------
phase_nginx() {
  rm -f /etc/nginx/sites-enabled/default

  # `http2 on;` needs nginx >= 1.25.1 (Ubuntu 24.04 ships 1.24 — use the
  # legacy `listen … http2` form there).
  local ngx_ver
  ngx_ver=$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
  HTTP2_LISTEN="" HTTP2_DIRECTIVE="    http2 on;"
  if [[ $(printf '%s\n' "$ngx_ver" 1.25 | sort -V | head -1) != 1.25 ]]; then
    HTTP2_LISTEN=" http2" HTTP2_DIRECTIVE=""
  fi

  cat >/etc/nginx/snippets/inventorypro-ssl.conf <<EOF
ssl_certificate     $CERT_DIR/fullchain.pem;
ssl_certificate_key $CERT_DIR/privkey.pem;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
ssl_session_cache shared:SSL:10m;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
EOF

  cat >/etc/nginx/conf.d/inventorypro-map.conf <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
EOF

  write_vhost() { # name domain port extra
    local name=$1 domain=$2 port=$3 extra=$4
    cat >"/etc/nginx/sites-available/inventorypro-$name.conf" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl$HTTP2_LISTEN;
    listen [::]:443 ssl$HTTP2_LISTEN;
$HTTP2_DIRECTIVE
    server_name $domain;
    include snippets/inventorypro-ssl.conf;
$extra
    location / {
        proxy_pass http://127.0.0.1:$port;
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
    ln -sf "/etc/nginx/sites-available/inventorypro-$name.conf" \
           "/etc/nginx/sites-enabled/inventorypro-$name.conf"
  }

  write_vhost api "$API_DOMAIN" "$PORT_API" \
'    client_max_body_size 25m;'
  write_vhost web "$WEB_DOMAIN" "$PORT_WEB" ''
  write_vhost s3  "$S3_DOMAIN"  "$PORT_S3" \
'    # media up/downloads: no size cap, stream straight through
    client_max_body_size 0;
    proxy_request_buffering off;'
  write_vhost minio "$MINIO_DOMAIN" "$PORT_CONSOLE" \
"    # management plane: WireGuard clients only
    allow $WG_SUBNET;
    allow 127.0.0.1;
    deny all;"

  nginx -t >>"$LOG_FILE" 2>&1 || { err "nginx config test failed:"; nginx -t; return 1; }
  systemctl enable --now nginx >>"$LOG_FILE" 2>&1
  systemctl reload nginx
  ok "nginx serving $API_DOMAIN, $WEB_DOMAIN, $S3_DOMAIN (+ $MINIO_DOMAIN via WireGuard)"
}

# ---------------------------------------------------------------------------
# Phase: wireguard
# ---------------------------------------------------------------------------
phase_wireguard() {
  umask 077
  local server_priv server_pub
  if [[ -f /etc/wireguard/server.key ]]; then
    server_priv=$(cat /etc/wireguard/server.key)
  else
    server_priv=$(wg genkey); printf '%s' "$server_priv" >/etc/wireguard/server.key
  fi
  server_pub=$(wg pubkey <<<"$server_priv")

  cat >/etc/wireguard/$WG_IF.conf <<EOF
# InventoryPro management tunnel — clients in $WG_DIR
[Interface]
Address = $WG_SERVER_IP/24
ListenPort = $WG_PORT
PrivateKey = $server_priv
EOF

  local i=2 name
  IFS=',' read -ra names <<<"$WG_CLIENT_NAMES"
  for name in "${names[@]}"; do
    name=$(tr -dc 'A-Za-z0-9_-' <<<"$name")
    [[ -n $name ]] || continue
    local cpriv cpub psk cip=10.8.0.$i
    cpriv=$(wg genkey); cpub=$(wg pubkey <<<"$cpriv"); psk=$(wg genpsk)
    cat >>/etc/wireguard/$WG_IF.conf <<EOF

[Peer]
# $name
PublicKey = $cpub
PresharedKey = $psk
AllowedIPs = $cip/32
EOF
    cat >"$WG_DIR/$name.conf" <<EOF
# InventoryPro VPS management — device: $name
[Interface]
PrivateKey = $cpriv
Address = $cip/24

[Peer]
PublicKey = $server_pub
PresharedKey = $psk
# Split tunnel: only the management subnet rides the tunnel.
AllowedIPs = $WG_SUBNET
Endpoint = $PUBLIC_IP:$WG_PORT
PersistentKeepalive = 25
EOF
    chmod 600 "$WG_DIR/$name.conf"
    info "client '$name' -> $cip  ($WG_DIR/$name.conf)"
    (( i++ ))
  done

  systemctl enable --now wg-quick@$WG_IF >>"$LOG_FILE" 2>&1 || {
    systemctl restart wg-quick@$WG_IF >>"$LOG_FILE" 2>&1
  }
  ok "WireGuard up on UDP $WG_PORT — import a client conf (QR below in the summary)"
}

# ---------------------------------------------------------------------------
# Phase: firewall
# ---------------------------------------------------------------------------
phase_firewall() {
  local ssh_port
  ssh_port=$( (sshd -T 2>/dev/null || true) | awk '/^port /{print $2; exit}')
  ssh_port=${ssh_port:-22}
  save_conf SSH_PORT "$ssh_port"

  ufw default deny incoming  >>"$LOG_FILE" 2>&1
  ufw default allow outgoing >>"$LOG_FILE" 2>&1
  ufw allow 80/tcp  comment 'http redirect'      >>"$LOG_FILE" 2>&1
  ufw allow 443/tcp comment 'https'              >>"$LOG_FILE" 2>&1
  ufw allow "$WG_PORT"/udp comment 'wireguard'   >>"$LOG_FILE" 2>&1
  ufw allow from "$WG_SUBNET" comment 'wireguard mgmt' >>"$LOG_FILE" 2>&1
  # SSH stays public until YOU verify WireGuard works — see finalize-lockdown.sh
  ufw allow "$ssh_port"/tcp comment 'ssh TEMPORARY public — finalize-lockdown.sh removes' >>"$LOG_FILE" 2>&1
  ufw --force enable >>"$LOG_FILE" 2>&1
  ok "UFW active: public = 80, 443, $WG_PORT/udp, $ssh_port/tcp(temporary); all else via WireGuard"
  warn "SSH is still open to the world ON PURPOSE — run finalize-lockdown.sh only"
  warn "after you have confirmed you can SSH in over WireGuard (ssh root@$WG_SERVER_IP)."
}

# ---------------------------------------------------------------------------
# Phase: app — clone, compose override, build, wait for health
# ---------------------------------------------------------------------------
phase_app() {
  if [[ -d $APP_DIR/.git ]]; then
    info "Repo already cloned — pulling latest '$GIT_BRANCH'…"
    git -C "$APP_DIR" fetch origin "$GIT_BRANCH" >>"$LOG_FILE" 2>&1
    git -C "$APP_DIR" checkout "$GIT_BRANCH"     >>"$LOG_FILE" 2>&1
    git -C "$APP_DIR" pull --ff-only             >>"$LOG_FILE" 2>&1
  else
    info "Cloning $GIT_REPO_URL (branch $GIT_BRANCH)…"
    git clone --branch "$GIT_BRANCH" "$GIT_REPO_URL" "$APP_DIR" >>"$LOG_FILE" 2>&1
  fi

  # Rebind every published port to loopback — nginx is the only public door.
  cat >"$INSTALL_DIR/compose.vps.yml" <<'EOF'
# VPS override — containers listen on 127.0.0.1 ONLY; host nginx is the edge.
services:
  # The repo pins minio/mc:RELEASE.2025-04-16T19-32-31Z, which no longer
  # exists on Docker Hub (MinIO prunes old tags). Nearest surviving tag:
  minio-init:
    image: minio/mc:RELEASE.2025-04-16T18-13-26Z
  api:
    ports: !override
      - "127.0.0.1:3000:3000"
  web:
    ports: !override
      - "127.0.0.1:8088:80"
  minio:
    ports: !override
      - "127.0.0.1:9000:9000"
      - "127.0.0.1:9001:9001"
EOF

  info "Building images (this is the slow part — several minutes on a small VPS)…"
  $COMPOSE build >>"$LOG_FILE" 2>&1 || { err "docker build failed — tail of log:"; tail -30 "$LOG_FILE" >&2; return 1; }
  $COMPOSE up -d >>"$LOG_FILE" 2>&1 || { err "docker compose up failed — tail of log:"; tail -40 "$LOG_FILE" >&2; return 1; }

  info "Waiting for the API to come up (runs DB migrations on first boot)…"
  local n=0
  until curl -fsS -m 5 "http://127.0.0.1:$PORT_API/health" >/dev/null 2>&1; do
    n=$((n + 1))
    if (( n > 60 )); then
      err "API not healthy after 5 minutes. Recent API logs:"
      $COMPOSE logs --tail 40 api >&2
      return 1
    fi
    sleep 5
  done
  ok "Stack is up — API /health OK, migrations applied"
}

# ---------------------------------------------------------------------------
# Phase: monitoring — healthchecks.io + systemd timer
# ---------------------------------------------------------------------------
hc_create_check() { # hc_create_check slug -> ping url on stdout
  curl -fsS -m 20 https://healthchecks.io/api/v1/checks/ \
    -H "X-Api-Key: $HC_API_KEY" \
    --data "{\"name\":\"inventorypro-$1\",\"tags\":\"inventorypro\",\"timeout\":120,\"grace\":300,\"unique\":[\"name\"]}" \
  | jq -r '.ping_url // empty'
}

phase_monitoring() {
  : >"$HC_ENV_FILE"; chmod 600 "$HC_ENV_FILE"
  case $HC_MODE in
    api)
      info "Creating healthchecks.io checks…"
      local c url
      for c in api web minio postgres disk tls; do
        url=$(hc_create_check "$c") || url=""
        [[ -n $url ]] || { warn "could not create check '$c' — is the API key a PROJECT key?"; continue; }
        echo "HC_URL_${c^^}=$url" >>"$HC_ENV_FILE"
        info "check inventorypro-$c -> $url"
      done
      ;;
    manual)
      echo "HC_HEARTBEAT_URL=$HC_HEARTBEAT_URL" >>"$HC_ENV_FILE"
      ;;
    off)
      info "No external pings configured — health results only go to the local log."
      ;;
  esac

  cat >/usr/local/bin/inventorypro-healthcheck.sh <<'EOF'
#!/usr/bin/env bash
# InventoryPro health monitor — run by inventorypro-health.timer every minute.
# Pings healthchecks.io per check (or one heartbeat), logs locally either way.
set -u
source /opt/inventorypro/install.conf   2>/dev/null || true
source /opt/inventorypro/healthchecks.env 2>/dev/null || true
LOG=/var/log/inventorypro-health.log
COMPOSE="docker compose --project-name inventorypro --env-file /opt/inventorypro/.env -f /opt/inventorypro/app/infra/docker-compose.prod.yml -f /opt/inventorypro/compose.vps.yml"

declare -A STATUS DETAIL
run_check() { # run_check name command...
  local name=$1; shift
  local out
  if out=$("$@" 2>&1); then STATUS[$name]=ok; else STATUS[$name]=fail; DETAIL[$name]=${out:0:400}; fi
}

run_check api      curl -fsS -m 10 http://127.0.0.1:3000/health
run_check web      curl -fsS -m 10 -o /dev/null http://127.0.0.1:8088/
run_check minio    curl -fsS -m 10 http://127.0.0.1:9000/minio/health/live
run_check postgres bash -c "$COMPOSE exec -T postgres pg_isready -q"
run_check disk     bash -c 'u=$(df --output=pcent / | tail -1 | tr -dc 0-9); [ "$u" -lt 90 ] || { echo "disk ${u}% full"; exit 1; }'
run_check tls      bash -c 'openssl x509 -noout -checkend 1209600 -in /etc/letsencrypt/live/inventorypro/cert.pem || { echo "cert expires within 14 days"; exit 1; }'

ping_url() { # ping_url base ok|fail [detail]
  local base=$1 st=$2 detail=${3:-}
  [ -n "$base" ] || return 0
  if [ "$st" = ok ]; then
    curl -fsS -m 10 --retry 2 -o /dev/null "$base" || true
  else
    curl -fsS -m 10 --retry 2 -o /dev/null --data-raw "$detail" "$base/fail" || true
  fi
}

overall=ok; summary=""
for name in api web minio postgres disk tls; do
  st=${STATUS[$name]:-fail}
  [ "$st" = ok ] || { overall=fail; summary+="$name: ${DETAIL[$name]:-failed}"$'\n'; }
  var="HC_URL_${name^^}"
  ping_url "${!var:-}" "$st" "${DETAIL[$name]:-}"
done
ping_url "${HC_HEARTBEAT_URL:-}" "$overall" "$summary"

if [ "$overall" = ok ]; then
  echo "$(date -Is) OK" >>"$LOG"
else
  printf '%s FAIL\n%s' "$(date -Is)" "$summary" >>"$LOG"
fi
EOF
  chmod 755 /usr/local/bin/inventorypro-healthcheck.sh

  cat >/etc/systemd/system/inventorypro-health.service <<'EOF'
[Unit]
Description=InventoryPro health check + healthchecks.io ping
[Service]
Type=oneshot
ExecStart=/usr/local/bin/inventorypro-healthcheck.sh
EOF
  cat >/etc/systemd/system/inventorypro-health.timer <<'EOF'
[Unit]
Description=Run InventoryPro health check every minute
[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
# default AccuracySec is 1min — without this the 1-min cadence drifts to 1-2min
# and healthchecks.io checks with tight timeouts flap while everything is healthy
AccuracySec=5s
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now inventorypro-health.timer >>"$LOG_FILE" 2>&1
  /usr/local/bin/inventorypro-healthcheck.sh || true
  ok "Health timer active (log: /var/log/inventorypro-health.log)"
}

# ---------------------------------------------------------------------------
# Phase: helpers — day-2 scripts
# ---------------------------------------------------------------------------
phase_helpers() {
  cat >"$BIN_DIR/upgrade.sh" <<'EOF'
#!/usr/bin/env bash
# Pull latest code, rebuild, restart. Migrations run automatically on API boot.
set -Eeuo pipefail
COMPOSE="docker compose --project-name inventorypro --env-file /opt/inventorypro/.env -f /opt/inventorypro/app/infra/docker-compose.prod.yml -f /opt/inventorypro/compose.vps.yml"
cd /opt/inventorypro/app
git pull --ff-only
$COMPOSE build
$COMPOSE up -d
docker image prune -f >/dev/null
echo "waiting for API health…"
for i in $(seq 1 60); do
  curl -fsS -m 5 http://127.0.0.1:3000/health >/dev/null 2>&1 && { echo "OK — upgrade complete"; exit 0; }
  sleep 5
done
echo "API did not come back — check: $COMPOSE logs --tail 50 api" >&2
exit 1
EOF

  cat >"$BIN_DIR/status.sh" <<'EOF'
#!/usr/bin/env bash
# One-screen status: containers, wireguard peers, last health results.
COMPOSE="docker compose --project-name inventorypro --env-file /opt/inventorypro/.env -f /opt/inventorypro/app/infra/docker-compose.prod.yml -f /opt/inventorypro/compose.vps.yml"
echo "── containers ─────────────────────────────"; $COMPOSE ps
echo "── wireguard ──────────────────────────────"; wg show
echo "── health (last 5) ────────────────────────"; tail -5 /var/log/inventorypro-health.log 2>/dev/null || echo "(no runs yet)"
echo "── disk ───────────────────────────────────"; df -h /
EOF

  cat >"$BIN_DIR/add-wg-client.sh" <<'EOF'
#!/usr/bin/env bash
# Add a WireGuard client: add-wg-client.sh <device-name>
set -Eeuo pipefail
source /opt/inventorypro/install.conf
name=$(tr -dc 'A-Za-z0-9_-' <<<"${1:?usage: add-wg-client.sh <device-name>}")
conf=/etc/wireguard/wg0.conf
[ -f "/opt/inventorypro/wireguard/$name.conf" ] && { echo "client '$name' already exists" >&2; exit 1; }
umask 077
# next free 10.8.0.x
for i in $(seq 2 254); do
  grep -q "10\.8\.0\.$i/32" "$conf" || { ip="10.8.0.$i"; break; }
done
[ -n "${ip:-}" ] || { echo "subnet full" >&2; exit 1; }
cpriv=$(wg genkey); cpub=$(wg pubkey <<<"$cpriv"); psk=$(wg genpsk)
server_pub=$(wg pubkey </etc/wireguard/server.key)
printf '\n[Peer]\n# %s\nPublicKey = %s\nPresharedKey = %s\nAllowedIPs = %s/32\n' "$name" "$cpub" "$psk" "$ip" >>"$conf"
wg syncconf wg0 <(wg-quick strip wg0)
out=/opt/inventorypro/wireguard/$name.conf
cat >"$out" <<CONF
[Interface]
PrivateKey = $cpriv
Address = $ip/24

[Peer]
PublicKey = $server_pub
PresharedKey = $psk
AllowedIPs = 10.8.0.0/24
Endpoint = $PUBLIC_IP:$WG_PORT
PersistentKeepalive = 25
CONF
chmod 600 "$out"
echo "client '$name' -> $ip  ($out)"
command -v qrencode >/dev/null && qrencode -t ansiutf8 <"$out"
EOF

  cat >"$BIN_DIR/finalize-lockdown.sh" <<'EOF'
#!/usr/bin/env bash
# Close public SSH — AFTER you have verified WireGuard access.
# Refuses to run unless it can see you are safe (SSH'd via the tunnel, or a
# recent WG handshake exists). Revert from the console: ufw allow <port>/tcp
set -Eeuo pipefail
source /opt/inventorypro/install.conf
port=${SSH_PORT:-22}

via_wg=no
if [[ ${SSH_CLIENT:-} == 10.8.0.* ]]; then via_wg=yes; fi
recent=no
now=$(date +%s)
while read -r _ hs; do
  [ "${hs:-0}" -gt 0 ] && [ $((now - hs)) -lt 180 ] && recent=yes
done < <(wg show wg0 latest-handshakes)

if [[ $via_wg == no && $recent == no ]]; then
  cat >&2 <<MSG
REFUSING to close public SSH:
  - this session did not come in over WireGuard, and
  - no WireGuard peer has completed a handshake in the last 3 minutes.
Connect a WireGuard client first, ideally SSH in via  ssh root@10.8.0.1 , then re-run.
MSG
  exit 1
fi

[[ $via_wg == yes ]] || {
  read -rp "You are NOT connected via WireGuard right now (a peer is, though). Close public SSH anyway? [y/N] " a
  [[ ${a,,} == y* ]] || exit 1
}

ufw delete allow "$port"/tcp || true
ufw status | grep -q "10.8.0.0/24" || ufw allow from 10.8.0.0/24
echo "Public SSH ($port/tcp) closed. SSH now works only through WireGuard: ssh root@10.8.0.1"
echo "Locked out? Use your VPS provider's web console and run: ufw allow $port/tcp"
EOF

  chmod 700 "$BIN_DIR"/*.sh
  ok "Helpers installed in $BIN_DIR: upgrade.sh, status.sh, add-wg-client.sh, finalize-lockdown.sh"
}

# ---------------------------------------------------------------------------
# Phase: summary
# ---------------------------------------------------------------------------
phase_summary() {
  write_creds_file   # refresh with everything known

  echo
  echo "${C_BLD}${C_GRN}════════════════════════════════════════════════════════════════${C_OFF}"
  echo "${C_BLD}${C_GRN}  InventoryPro VPS install complete${C_OFF}"
  echo "${C_BLD}${C_GRN}════════════════════════════════════════════════════════════════${C_OFF}"
  cat "$CREDS_FILE"
  echo
  step "WireGuard client QR codes (scan with the WireGuard mobile app)"
  local f
  for f in "$WG_DIR"/*.conf; do
    [[ -e $f ]] || continue
    echo "${C_BLD}--- $(basename "$f" .conf) ---${C_OFF}"
    qrencode -t ansiutf8 <"$f" || true
    echo
  done

  step "YOUR checklist — do these now, in order"
  cat <<EOF
  1. Open https://$WEB_DOMAIN and https://$API_DOMAIN/health in a browser —
     both must load with a valid padlock.
  2. Import a WireGuard client conf ($WG_DIR/*.conf or a QR above)
     on your laptop/phone and connect.
  3. While on WireGuard, verify the management plane:
        ssh root@$WG_SERVER_IP          (tunnel SSH)
        https://$MINIO_DOMAIN           (MinIO console — login above)
  4. ONLY once step 3 works, close public SSH:
        $BIN_DIR/finalize-lockdown.sh
  5. Log in to the app and create your first admin user / test a photo upload
     (exercises MinIO through https://$S3_DOMAIN).
  6. Check https://healthchecks.io — all 'inventorypro-*' checks should be
     green within a couple of minutes. Kill a container to see an alert fire.
  7. Copy $CREDS_FILE somewhere safe (password manager), then optionally
     delete it from the server.
  8. Set up automatic backups (nightly Postgres dump + media mirror, plus
     Google Drive off-site): run infra/vps/setup-backups.sh — see
     docs/BACKUPS.md in the repo.

  Day-2 operations:
      $BIN_DIR/status.sh            overview
      $BIN_DIR/upgrade.sh           deploy latest code
      $BIN_DIR/add-wg-client.sh X   add a device
      $LOG_FILE   (install log)  /var/log/inventorypro-health.log  (monitor log)
EOF
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
mkdir -p "$STATE_DIR" 2>/dev/null || true
if [[ -f $CONF_FILE ]]; then source "$CONF_FILE"; fi

echo "${C_BLD}InventoryPro VPS installer${C_OFF} — log: $LOG_FILE"
log "===== install.sh started $(date -Is) ====="

run_phase preflight  "Phase 1/13 — Preflight (OS check, base tools, public IP)" phase_preflight
run_phase interview  "Phase 2/13 — Interview (all questions, asked once)"       phase_interview
run_phase secrets    "Phase 3/13 — Generate secrets & write env"                phase_secrets
run_phase packages   "Phase 4/13 — Install Docker, nginx, certbot, WireGuard"   phase_packages
run_phase dns        "Phase 5/13 — Cloudflare DNS records"                      phase_dns
run_phase certs      "Phase 6/13 — Let's Encrypt certificate (DNS-01)"          phase_certs
run_phase nginx      "Phase 7/13 — nginx vhosts"                                phase_nginx
run_phase wireguard  "Phase 8/13 — WireGuard tunnel + client configs"           phase_wireguard
run_phase firewall   "Phase 9/13 — UFW firewall"                                phase_firewall
run_phase app        "Phase 10/13 — Clone, build & start InventoryPro"          phase_app
run_phase monitoring "Phase 11/13 — healthchecks.io monitoring"                 phase_monitoring
run_phase helpers    "Phase 12/13 — Day-2 helper scripts"                       phase_helpers
CURRENT_PHASE=summary
step "Phase 13/13 — Summary"
phase_summary
log "===== install.sh finished $(date -Is) ====="
