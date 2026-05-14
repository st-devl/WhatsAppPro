#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

REMOTE_HOST="${DEPLOY_REMOTE_HOST:-u341720642@141.136.43.125}"
REMOTE_SSH_PORT="${DEPLOY_REMOTE_SSH_PORT:-65002}"
PASSENGER_PATH="${DEPLOY_REMOTE_PASSENGER_PATH:-/home/u341720642/domains/yardimet.site/nodejs}"
DATA_PATH="${DEPLOY_REMOTE_DATA_PATH:-/home/u341720642/domains/yardimet.site/app-data}"
HEALTH_URL="${DEPLOY_REMOTE_HEALTH_URL:-https://yardimet.site/readyz}"
HEALTH_TIMEOUT_SECONDS="${DEPLOY_HEALTH_TIMEOUT_SECONDS:-90}"
CACHE_ROOT="${WHASAPPC_DEPLOY_CACHE:-$HOME/.cache/whasappc-deploy}"
CACHE_KEEP="${WHASAPPC_DEPLOY_CACHE_KEEP:-3}"
RUN_TESTS=0
SKIP_CSS_BUILD=0
SETUP_ENV=0
FORCE_REINSTALL=0
SETUP_ADMIN_EMAIL=""
SETUP_ADMIN_PASSWORD=""

usage() {
    cat <<'USAGE'
Usage:
  ./deploy-production.sh [--with-tests] [--skip-css-build] [--setup-env] [--force-reinstall]

Hostinger Passenger production deploy (rsync incremental + node_modules cache).

Defaults:
  DEPLOY_REMOTE_HOST=u341720642@141.136.43.125
  DEPLOY_REMOTE_SSH_PORT=65002
  DEPLOY_REMOTE_PASSENGER_PATH=/home/u341720642/domains/yardimet.site/nodejs
  DEPLOY_REMOTE_DATA_PATH=/home/u341720642/domains/yardimet.site/app-data
  DEPLOY_REMOTE_HEALTH_URL=https://yardimet.site/readyz
  WHASAPPC_DEPLOY_CACHE=~/.cache/whasappc-deploy

Behavior:
  - Preserves remote .env and persistent runtime data (data/, auth/, uploads/).
  - Caches node_modules locally keyed by package-lock.json hash; skips npm ci
    when the lock file is unchanged.
  - Uses rsync (delta transfer) instead of tar+scp; only changed files cross the wire.

Options:
  --with-tests        Run tests before deploy.
  --skip-css-build    Skip Tailwind/CSS build.
  --setup-env         Create remote .env if missing. Prompts for admin email/password.
  --force-reinstall   Ignore node_modules cache; run npm ci from scratch.
USAGE
}

info()    { printf '\033[0;34m%s\033[0m\n' "$*"; }
success() { printf '\033[0;32m%s\033[0m\n' "$*"; }
warn()    { printf '\033[1;33m%s\033[0m\n' "$*"; }
fail()    { printf '\033[0;31mHATA: %s\033[0m\n' "$*" >&2; exit 1; }

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "$1 bulunamadi."
}

shell_quote() {
    printf "%q" "$1"
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --with-tests)        RUN_TESTS=1; shift ;;
        --skip-css-build)    SKIP_CSS_BUILD=1; shift ;;
        --setup-env)         SETUP_ENV=1; shift ;;
        --force-reinstall)   FORCE_REINSTALL=1; shift ;;
        -h|--help)           usage; exit 0 ;;
        *)                   fail "Bilinmeyen arguman: $1" ;;
    esac
done

require_command git
require_command node
require_command npm
require_command ssh
require_command scp
require_command rsync

node -e "const major = Number(process.versions.node.split('.')[0]); if (major < 20 || major >= 26) { console.error('Node.js >=20 <26 required. Current: ' + process.version); process.exit(1); }"

if [ "$SETUP_ENV" -eq 1 ]; then
    printf "Admin e-posta: "
    read -r SETUP_ADMIN_EMAIL
    printf "Admin sifre: "
    stty_state="$(stty -g)"
    stty -echo
    if ! read -r SETUP_ADMIN_PASSWORD; then
        stty "$stty_state"
        fail "Admin sifre okunamadi."
    fi
    stty "$stty_state"
    printf "\n"
    [ -n "$SETUP_ADMIN_EMAIL" ] || fail "Admin e-posta bos olamaz."
    [ -n "$SETUP_ADMIN_PASSWORD" ] || fail "Admin sifre bos olamaz."
fi

commit="$(git rev-parse HEAD)"
short_commit="$(git rev-parse --short=12 HEAD)"
tmp_dir="$(mktemp -d)"
control_dir="/tmp/whc-deploy-$$"
mkdir -p "$control_dir"
control_path="$control_dir/ctl"
env_artifact=""
remote_env_artifact=""
ssh_master_started=0

mkdir -p "$CACHE_ROOT"

cleanup() {
    if [ "$ssh_master_started" -eq 1 ]; then
        ssh -p "$REMOTE_SSH_PORT" \
            -o ControlPath="$control_path" \
            -O exit "$REMOTE_HOST" >/dev/null 2>&1 || true
    fi
    rm -rf "$tmp_dir"
    rm -rf "$control_dir"
}
trap cleanup EXIT

ssh_opts=(
    -p "$REMOTE_SSH_PORT"
    -o ControlMaster=auto
    -o ControlPath="$control_path"
    -o ControlPersist=60
)
scp_opts=(
    -P "$REMOTE_SSH_PORT"
    -o ControlPath="$control_path"
)
rsync_ssh="ssh -p $REMOTE_SSH_PORT -o ControlPath=$control_path"
rsync_opts=(
    -az
    --delete-after
    --partial
    --human-readable
    -e "$rsync_ssh"
)

info "[1/7] Frontend build"
if [ "$SKIP_CSS_BUILD" -eq 1 ]; then
    warn "CSS build atlandi."
else
    npm --prefix whatsapp-engine run build:css
fi

info "[2/7] Release manifest"
npm --prefix whatsapp-engine run release:manifest -- --environment production --commit "$commit"

info "[3/7] Tests"
if [ "$RUN_TESTS" -eq 1 ]; then
    npm --prefix whatsapp-engine test
else
    warn "Testler atlandi. Tam dogrulama: ./deploy-production.sh --with-tests"
fi

info "[4/7] node_modules cache"
LOCK_HASH="$(node -e "const fs=require('fs');const c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync('whatsapp-engine/package-lock.json')).digest('hex').slice(0,16));")"
NODE_MODULES_CACHE="$CACHE_ROOT/node_modules-$LOCK_HASH"
CACHE_SENTINEL="$NODE_MODULES_CACHE/.deploy-complete"

if [ "$FORCE_REINSTALL" -eq 1 ]; then
    rm -rf "$NODE_MODULES_CACHE"
fi

if [ -f "$CACHE_SENTINEL" ]; then
    success "node_modules cache HIT (lock $LOCK_HASH)"
else
    info "Cache MISS, npm ci calisiyor (lock $LOCK_HASH)..."
    install_tmp="$tmp_dir/install"
    mkdir -p "$install_tmp"
    cp whatsapp-engine/package.json whatsapp-engine/package-lock.json "$install_tmp/"
    (cd "$install_tmp" && npm ci --omit=dev --omit=optional --no-audit --no-fund --no-bin-links)
    touch "$install_tmp/node_modules/.deploy-complete"
    rm -rf "$NODE_MODULES_CACHE"
    mv "$install_tmp/node_modules" "$NODE_MODULES_CACHE"
    success "node_modules cache yenilendi (lock $LOCK_HASH)"
fi

if [ "$CACHE_KEEP" -gt 0 ]; then
    # En son N hash disinda eskileri sil.
    ls -1dt "$CACHE_ROOT"/node_modules-* 2>/dev/null \
        | tail -n +$((CACHE_KEEP + 1)) \
        | while IFS= read -r old; do
            [ -n "$old" ] && rm -rf "$old"
        done
fi

if [ "$SETUP_ENV" -eq 1 ]; then
    admin_pass_hash="$(NODE_PATH="$NODE_MODULES_CACHE" ADMIN_PASSWORD="$SETUP_ADMIN_PASSWORD" node -e 'const bcrypt = require("bcryptjs"); process.stdout.write(bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12));')"
    session_secret="$(node -e 'process.stdout.write(require("crypto").randomBytes(48).toString("hex"));')"
    env_artifact="$tmp_dir/production.env"
    remote_env_artifact="/tmp/whatsappc-production-env-$short_commit-$$"
    cat > "$env_artifact" <<ENV
NODE_ENV=production
TRUST_PROXY=1
COOKIE_SECURE=true
SESSION_STORE=sqlite
WHASAPPC_DATA_DIR=$DATA_PATH
TZ=Europe/Istanbul
ADMIN_EMAIL=$SETUP_ADMIN_EMAIL
ADMIN_PASS_HASH=$admin_pass_hash
SESSION_SECRET=$session_secret
DEFAULT_TENANT_ID=default
WHATSAPP_MAX_AUTO_RETRIES=3
KEEP_AWAKE_DURING_CAMPAIGN=true
CAMPAIGN_BATCH_SIZE=50
CAMPAIGN_BATCH_PAUSE_MINUTES=40
LOGIN_RATE_LIMIT_WINDOW_MS=900000
LOGIN_RATE_LIMIT_MAX=5
UPLOAD_MAX_FILE_SIZE_BYTES=52428800
MEDIA_TOTAL_QUOTA_BYTES=524288000
MEDIA_RETENTION_MS=604800000
EXCEL_IMPORT_TIMEOUT_MS=30000
LOG_LEVEL=info
BACKUP_RETENTION_COUNT=30
PROCESS_LOCK_WAIT_MS=15000
AUDIT_RETENTION_DAYS=30
CAMPAIGN_LOG_RETENTION_DAYS=30
DAILY_STATS_RETENTION_DAYS=90
SYSTEM_EVENTS_RETENTION_DAYS=30
ENV
    chmod 600 "$env_artifact"
    SETUP_ADMIN_PASSWORD=""
fi

info "[5/7] SSH baglantisi"
info "SSH ControlMaster aciliyor. Parola gerekiyorsa bu adimda bir kez girilecek."
ssh "${ssh_opts[@]}" -fN "$REMOTE_HOST"
ssh_master_started=1

passenger_path_q="$(shell_quote "$PASSENGER_PATH")"
data_path_q="$(shell_quote "$DATA_PATH")"
remote_env_artifact_q="$(shell_quote "$remote_env_artifact")"

ssh "${ssh_opts[@]}" "$REMOTE_HOST" "set -euo pipefail
mkdir -p $passenger_path_q $passenger_path_q/tmp $passenger_path_q/node_modules \
         $data_path_q $data_path_q/uploads $data_path_q/auth $data_path_q/backups
if ! command -v node >/dev/null 2>&1; then
    echo 'HATA: remote node bulunamadi.' >&2
    exit 1
fi
node -e \"const major = Number(process.versions.node.split('.')[0]); if (major < 20 || major >= 26) { console.error('Node.js >=20 <26 required. Current: ' + process.version); process.exit(1); }\"
"

if [ "$SETUP_ENV" -eq 1 ]; then
    scp "${scp_opts[@]}" "$env_artifact" "$REMOTE_HOST:$remote_env_artifact"
fi

info "[6/7] rsync (uygulama + node_modules)"
# Uygulama dosyalari (node_modules ve persistent yollar haric).
rsync "${rsync_opts[@]}" \
    --exclude='/node_modules/' \
    --exclude='/.env' \
    --exclude='/data/' \
    --exclude='/auth/' \
    --exclude='/uploads/' \
    --exclude='/tmp/' \
    whatsapp-engine/ "$REMOTE_HOST:$PASSENGER_PATH/"

# node_modules (cache'den dogrudan delta sync).
rsync "${rsync_opts[@]}" \
    "$NODE_MODULES_CACHE/" "$REMOTE_HOST:$PASSENGER_PATH/node_modules/"

ssh "${ssh_opts[@]}" "$REMOTE_HOST" "set -euo pipefail
passenger_path=$passenger_path_q
data_path=$data_path_q
env_artifact=$remote_env_artifact_q

set_env_file() {
    env_file=\"\$1\"
    key=\"\$2\"
    value=\"\$3\"
    tmp_file=\"\$(mktemp)\"
    if [ -f \"\$env_file\" ]; then
        awk -v k=\"\$key\" -v v=\"\$value\" 'BEGIN{done=0} \$0 ~ \"^\" k \"=\" { print k \"=\" v; done=1; next } { print } END{ if (!done) print k \"=\" v }' \"\$env_file\" > \"\$tmp_file\"
    else
        printf '%s=%s\n' \"\$key\" \"\$value\" > \"\$tmp_file\"
    fi
    mv \"\$tmp_file\" \"\$env_file\"
}

env_value() {
    env_file=\"\$1\"
    key=\"\$2\"
    grep -E \"^\${key}=\" \"\$env_file\" | tail -n 1 | cut -d= -f2- || true
}

validate_runtime_env() {
    env_file=\"\$1\"
    missing=''
    for key in ADMIN_EMAIL ADMIN_PASS_HASH SESSION_SECRET; do
        if [ -z \"\$(env_value \"\$env_file\" \"\$key\")\" ]; then
            missing=\"\$missing \$key\"
        fi
    done
    if [ -n \"\$missing\" ]; then
        echo \"HATA: \$env_file icinde eksik zorunlu degiskenler:\$missing\" >&2
        exit 1
    fi
    session_secret=\"\$(env_value \"\$env_file\" SESSION_SECRET)\"
    pass_hash=\"\$(env_value \"\$env_file\" ADMIN_PASS_HASH)\"
    if [ \"\$session_secret\" = 'change-me-to-a-long-random-secret' ] || [ \"\${#session_secret}\" -lt 32 ]; then
        echo 'HATA: SESSION_SECRET production icin guvenli degil.' >&2
        exit 1
    fi
    if [ \"\$pass_hash\" = 'replace-with-bcrypt-hash' ]; then
        echo 'HATA: ADMIN_PASS_HASH placeholder degerinde.' >&2
        exit 1
    fi
}

if [ ! -f \"\$passenger_path/.env\" ]; then
    if [ -n \"\$env_artifact\" ] && [ -s \"\$env_artifact\" ]; then
        mv \"\$env_artifact\" \"\$passenger_path/.env\"
        chmod 600 \"\$passenger_path/.env\"
        echo 'Remote .env olusturuldu.'
    else
        echo \"HATA: \$passenger_path/.env bulunamadi. Ilk kurulum icin ./deploy-production.sh --setup-env calistirin.\" >&2
        exit 1
    fi
elif [ -n \"\$env_artifact\" ]; then
    rm -f \"\$env_artifact\" || true
fi

set_env_file \"\$passenger_path/.env\" NODE_ENV production
set_env_file \"\$passenger_path/.env\" TRUST_PROXY 1
set_env_file \"\$passenger_path/.env\" COOKIE_SECURE true
set_env_file \"\$passenger_path/.env\" SESSION_STORE sqlite
set_env_file \"\$passenger_path/.env\" WHASAPPC_DATA_DIR \"\$data_path\"
set_env_file \"\$passenger_path/.env\" TZ Europe/Istanbul
set_env_file \"\$passenger_path/.env\" PROCESS_LOCK_WAIT_MS 15000
set_env_file \"\$passenger_path/.env\" AUDIT_RETENTION_DAYS 30
set_env_file \"\$passenger_path/.env\" CAMPAIGN_LOG_RETENTION_DAYS 30
set_env_file \"\$passenger_path/.env\" DAILY_STATS_RETENTION_DAYS 90
set_env_file \"\$passenger_path/.env\" SYSTEM_EVENTS_RETENTION_DAYS 30
validate_runtime_env \"\$passenger_path/.env\"

if command -v pm2 >/dev/null 2>&1; then
    pm2 delete whasappc >/dev/null 2>&1 || true
    pm2 delete yardimet.site >/dev/null 2>&1 || true
    pm2 save >/dev/null 2>&1 || true
fi

test -s \"\$passenger_path/index.js\"
test -s \"\$passenger_path/package.json\"
test -d \"\$passenger_path/node_modules\"

(cd \"\$passenger_path\" && node scripts/migrate.js apply)
touch \"\$passenger_path/tmp/restart.txt\"
echo 'Remote Passenger deploy staged.'
"

info "[7/7] Public health check"
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
while true; do
    if node -e "fetch(process.argv[1]).then(res => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))" "$HEALTH_URL" >/dev/null 2>&1; then
        success "Health check OK: $HEALTH_URL"
        success "Production deploy tamamlandi."
        exit 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
        fail "Health check zaman asimi: $HEALTH_URL"
    fi
    sleep 2
done
