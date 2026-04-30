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
RUN_TESTS=0
SKIP_CSS_BUILD=0

usage() {
    cat <<'USAGE'
Usage:
  ./deploy-production.sh [--with-tests] [--skip-css-build]

This is the simple Hostinger Passenger production deploy path.

Defaults:
  DEPLOY_REMOTE_HOST=u341720642@141.136.43.125
  DEPLOY_REMOTE_SSH_PORT=65002
  DEPLOY_REMOTE_PASSENGER_PATH=/home/u341720642/domains/yardimet.site/nodejs
  DEPLOY_REMOTE_DATA_PATH=/home/u341720642/domains/yardimet.site/app-data
  DEPLOY_REMOTE_HEALTH_URL=https://yardimet.site/readyz

The script does not require a clean git tree and does not push to GitHub.
It preserves the remote .env and persistent runtime data.
USAGE
}

info() { printf '\033[0;34m%s\033[0m\n' "$*"; }
success() { printf '\033[0;32m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
fail() { printf '\033[0;31mHATA: %s\033[0m\n' "$*" >&2; exit 1; }

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "$1 bulunamadi."
}

shell_quote() {
    printf "%q" "$1"
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --with-tests)
            RUN_TESTS=1
            shift
            ;;
        --skip-css-build)
            SKIP_CSS_BUILD=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            fail "Bilinmeyen arguman: $1"
            ;;
    esac
done

require_command git
require_command node
require_command npm
require_command ssh
require_command scp
require_command tar

node -e "const major = Number(process.versions.node.split('.')[0]); if (major < 20 || major >= 26) { console.error('Node.js >=20 <26 required. Current: ' + process.version); process.exit(1); }"

commit="$(git rev-parse HEAD)"
short_commit="$(git rev-parse --short=12 HEAD)"
tmp_dir="$(mktemp -d)"
control_dir="/tmp/whc-deploy-$$"
mkdir -p "$control_dir"
control_path="$control_dir/ctl"
artifact="$tmp_dir/whatsappc-production-$short_commit.tar.gz"
remote_artifact="/tmp/whatsappc-production-$short_commit.tar.gz"
ssh_master_started=0

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
    -o ControlMaster=auto
    -o ControlPath="$control_path"
    -o ControlPersist=60
)

info "[1/6] Frontend build"
if [ "$SKIP_CSS_BUILD" -eq 1 ]; then
    warn "CSS build atlandi."
else
    npm --prefix whatsapp-engine run build:css
fi

info "[2/6] Release manifest"
npm --prefix whatsapp-engine run release:manifest -- --environment production --commit "$commit"

if [ "$RUN_TESTS" -eq 1 ]; then
    info "[3/6] Tests"
    npm --prefix whatsapp-engine test
else
    info "[3/6] Tests"
    warn "Testler atlandi. Deploy oncesi tam dogrulama icin: ./deploy-production.sh --with-tests"
fi

info "[4/6] Artifact hazirlaniyor"
stage_dir="$tmp_dir/stage"
deps_dir="$tmp_dir/deps/whatsapp-engine"
mkdir -p "$stage_dir/app" "$deps_dir"

cp whatsapp-engine/package.json whatsapp-engine/package-lock.json "$deps_dir/"
(cd "$deps_dir" && npm ci --omit=dev --omit=optional --no-audit --no-fund --no-bin-links)
node -e "const fs = require('fs'); const crypto = require('crypto'); process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'));" \
    "$deps_dir/package-lock.json" > "$deps_dir/node_modules/.package-lock.sha256"

tar_create_args=()
if COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 tar --no-mac-metadata -cf /dev/null --files-from /dev/null >/dev/null 2>&1; then
    tar_create_args+=(--no-mac-metadata)
fi

COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 tar "${tar_create_args[@]}" \
    --exclude='./node_modules' \
    --exclude='./.env' \
    --exclude='./data' \
    --exclude='./auth' \
    --exclude='./uploads' \
    --exclude='./tmp' \
    -C whatsapp-engine -cf - . | tar -C "$stage_dir/app" -xf -
mv "$deps_dir/node_modules" "$stage_dir/app/node_modules"
COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 tar "${tar_create_args[@]}" -C "$stage_dir/app" -czf "$artifact" .

info "[5/6] Remote deploy"
info "SSH baglantisi aciliyor. Parola gerekiyorsa bu adimda bir kez girilecek."
ssh "${ssh_opts[@]}" -fN "$REMOTE_HOST"
ssh_master_started=1
scp "${scp_opts[@]}" "$artifact" "$REMOTE_HOST:$remote_artifact"

passenger_path_q="$(shell_quote "$PASSENGER_PATH")"
data_path_q="$(shell_quote "$DATA_PATH")"
remote_artifact_q="$(shell_quote "$remote_artifact")"

ssh "${ssh_opts[@]}" "$REMOTE_HOST" "set -euo pipefail
passenger_path=$passenger_path_q
data_path=$data_path_q
artifact=$remote_artifact_q

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

if ! command -v node >/dev/null 2>&1; then
    echo 'HATA: remote node bulunamadi.' >&2
    exit 1
fi
node -e \"const major = Number(process.versions.node.split('.')[0]); if (major < 20 || major >= 26) { console.error('Node.js >=20 <26 required. Current: ' + process.version); process.exit(1); }\"

mkdir -p \"\$passenger_path\" \"\$passenger_path/tmp\" \"\$data_path\" \"\$data_path/uploads\" \"\$data_path/auth\" \"\$data_path/backups\"
if [ ! -f \"\$passenger_path/.env\" ]; then
    echo \"HATA: \$passenger_path/.env bulunamadi. Once production secretlarini olusturun.\" >&2
    exit 1
fi

set_env_file \"\$passenger_path/.env\" NODE_ENV production
set_env_file \"\$passenger_path/.env\" TRUST_PROXY 1
set_env_file \"\$passenger_path/.env\" COOKIE_SECURE true
set_env_file \"\$passenger_path/.env\" SESSION_STORE sqlite
set_env_file \"\$passenger_path/.env\" WHASAPPC_DATA_DIR \"\$data_path\"
validate_runtime_env \"\$passenger_path/.env\"

if command -v pm2 >/dev/null 2>&1; then
    pm2 delete whasappc >/dev/null 2>&1 || true
    pm2 delete yardimet.site >/dev/null 2>&1 || true
    pm2 save >/dev/null 2>&1 || true
fi

staging=\"\$passenger_path/.deploy-staging-\$(date +%s)-\$\$\"
rm -rf \"\$staging\"
mkdir -p \"\$staging\"
tar -xzf \"\$artifact\" -C \"\$staging\"
test -s \"\$staging/index.js\"
test -s \"\$staging/package.json\"
test -d \"\$staging/node_modules\"

find \"\$passenger_path\" -mindepth 1 -maxdepth 1 \
    ! -name .env \
    ! -name tmp \
    -exec rm -rf {} +
cp -a \"\$staging\"/. \"\$passenger_path\"/
rm -rf \"\$staging\" \"\$artifact\"

(cd \"\$passenger_path\" && node scripts/migrate.js apply)
touch \"\$passenger_path/tmp/restart.txt\"
echo 'Remote Passenger deploy staged.'
"

info "[6/6] Public health check"
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
