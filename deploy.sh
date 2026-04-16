#!/bin/bash
set -euo pipefail

export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ENV_FILE="whatsapp-engine/.env"
ENV_EXAMPLE="whatsapp-engine/.env.example"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
COMPOSE_SERVICE="${COMPOSE_SERVICE:-whasappc}"
DEPLOY_TARGET="${DEPLOY_TARGET:-local}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
DEPLOY_HEALTH_URL="${DEPLOY_HEALTH_URL:-http://127.0.0.1:3005/readyz}"
DEPLOY_HEALTH_TIMEOUT_SECONDS="${DEPLOY_HEALTH_TIMEOUT_SECONDS:-90}"
DEPLOY_REMOTE_HOST="${DEPLOY_REMOTE_HOST:-}"
DEPLOY_REMOTE_PATH="${DEPLOY_REMOTE_PATH:-}"
DEPLOY_REMOTE_BRANCH="${DEPLOY_REMOTE_BRANCH:-$DEPLOY_BRANCH}"
DEPLOY_REMOTE_HEALTH_URL="${DEPLOY_REMOTE_HEALTH_URL:-}"

RUN_TESTS=1
RUN_CSS_BUILD=1
BUMP_PATCH=0
PUSH_AFTER_COMMIT=0
COMMIT_STAGED_MESSAGE=""

usage() {
    cat <<'USAGE'
Usage:
  ./deploy.sh [options]

Targets:
  --target local          Build and run with Docker Compose on this machine. Default.
  --target remote         Pull and deploy on a remote server over SSH.
  --local                 Same as --target local.
  --remote                Same as --target remote.

Options:
  --bump-patch            Bump whatsapp-engine package patch version before checks.
  --skip-tests            Skip npm test. Use only for emergency hotfix deploys.
  --skip-css-build        Skip Tailwind CSS build.
  --commit-staged "msg"   Commit already staged changes with the given message.
  --push                  Push the current branch to origin after optional commit.
  -h, --help              Show this help.

Environment:
  COMPOSE_FILE                      Default: docker-compose.yml
  COMPOSE_SERVICE                   Default: whasappc
  DEPLOY_TARGET                     local or remote
  DEPLOY_HEALTH_URL                 Default: http://127.0.0.1:3005/readyz
  DEPLOY_HEALTH_TIMEOUT_SECONDS     Default: 90
  DEPLOY_REMOTE_HOST                Required for remote. Example: user@server
  DEPLOY_REMOTE_PATH                Required for remote. Example: /opt/WhasAppC
  DEPLOY_REMOTE_BRANCH              Default: current local branch
  DEPLOY_REMOTE_HEALTH_URL          Optional public URL checked after remote deploy

Examples:
  ./deploy.sh
  ./deploy.sh --commit-staged "deploy: release latest fixes" --push
  DEPLOY_TARGET=remote DEPLOY_REMOTE_HOST=user@1.2.3.4 DEPLOY_REMOTE_PATH=/opt/WhasAppC ./deploy.sh --push
USAGE
}

info() {
    echo -e "${BLUE}$*${NC}"
}

success() {
    echo -e "${GREEN}$*${NC}"
}

warn() {
    echo -e "${YELLOW}$*${NC}"
}

fail() {
    echo -e "${RED}HATA: $*${NC}" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "$1 bulunamadi."
}

env_value() {
    local file="$1"
    local key="$2"
    grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- || true
}

validate_env_file() {
    local file="$1"
    local example="$2"

    if [ ! -f "$file" ]; then
        warn "UYARI: $file bulunamadi."
        if [ -f "$example" ]; then
            cp "$example" "$file"
            warn "Ornek dosyadan .env olusturuldu. Degerleri doldurup tekrar calistirin:"
            warn "  nano $file"
            warn "Ozellikle ADMIN_EMAIL, ADMIN_PASS_HASH ve SESSION_SECRET zorunludur."
            echo ""
            warn "Sifre hash'i olusturmak icin:"
            echo "  node -e \"require('bcryptjs').hash('SIFRENIZ', 10).then(h => console.log(h))\""
            exit 1
        fi
        fail "$example bulunamadi. .env dosyasini manuel olusturun."
    fi

    local required_vars="ADMIN_EMAIL ADMIN_PASS_HASH SESSION_SECRET"
    local missing=""
    local key
    local value

    for key in $required_vars; do
        value="$(env_value "$file" "$key")"
        if [ -z "$value" ]; then
            missing="$missing $key"
        fi
    done

    if [ -n "$missing" ]; then
        fail "$file dosyasinda eksik zorunlu degiskenler:$missing"
    fi

    value="$(env_value "$file" "ADMIN_PASS_HASH")"
    if [ "$value" = "replace-with-bcrypt-hash" ]; then
        fail "ADMIN_PASS_HASH hala placeholder degerinde. Bcrypt hash yazilmali."
    fi

    value="$(env_value "$file" "SESSION_SECRET")"
    if [ "$value" = "change-me-to-a-long-random-secret" ] || [ "${#value}" -lt 32 ]; then
        fail "SESSION_SECRET production icin guclu ve en az 32 karakter olmali."
    fi

    success ".env kontrolu: OK"
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --target)
                [ "$#" -ge 2 ] || fail "--target icin local veya remote degeri gerekli."
                DEPLOY_TARGET="$2"
                shift 2
                ;;
            --target=*)
                DEPLOY_TARGET="${1#*=}"
                shift
                ;;
            --local)
                DEPLOY_TARGET="local"
                shift
                ;;
            --remote)
                DEPLOY_TARGET="remote"
                shift
                ;;
            --bump-patch)
                BUMP_PATCH=1
                shift
                ;;
            --skip-tests)
                RUN_TESTS=0
                shift
                ;;
            --skip-css-build)
                RUN_CSS_BUILD=0
                shift
                ;;
            --commit-staged)
                [ "$#" -ge 2 ] || fail "--commit-staged icin commit mesaji gerekli."
                COMMIT_STAGED_MESSAGE="$2"
                shift 2
                ;;
            --push)
                PUSH_AFTER_COMMIT=1
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

    case "$DEPLOY_TARGET" in
        local|remote) ;;
        *) fail "DEPLOY_TARGET local veya remote olmali. Gelen: $DEPLOY_TARGET" ;;
    esac
}

run_preflight() {
    info "=============================================="
    info "   WhasAppC deploy preflight"
    info "=============================================="

    require_command git
    require_command node
    require_command npm

    validate_env_file "$ENV_FILE" "$ENV_EXAMPLE"

    if [ "$BUMP_PATCH" -eq 1 ]; then
        warn "whatsapp-engine patch version artiriliyor..."
        npm --prefix whatsapp-engine version patch --no-git-tag-version
    fi

    info "Whitespace kontrolleri calisiyor..."
    git diff --check
    git diff --cached --check

    info "Node.js runtime uyumlulugu kontrol ediliyor..."
    node -e "const major = Number(process.versions.node.split('.')[0]); if (major < 20 || major >= 26) { console.error('Node.js >=20 <26 required. Current: ' + process.version); process.exit(1); }"

    if [ "$RUN_CSS_BUILD" -eq 1 ]; then
        info "Frontend CSS build calisiyor..."
        npm --prefix whatsapp-engine run build:css
    else
        warn "CSS build atlandi."
    fi

    if [ "$RUN_TESTS" -eq 1 ]; then
        info "Application verification calisiyor..."
        npm --prefix whatsapp-engine test
    else
        warn "Testler atlandi."
    fi
}

commit_staged_if_requested() {
    if [ -z "$COMMIT_STAGED_MESSAGE" ]; then
        return
    fi

    if git diff --cached --quiet; then
        fail "--commit-staged verildi ama staged degisiklik yok."
    fi

    info "Staged degisiklikler commit ediliyor..."
    git commit -m "$COMMIT_STAGED_MESSAGE"
}

push_if_requested() {
    if [ "$PUSH_AFTER_COMMIT" -ne 1 ]; then
        return
    fi

    info "Branch push ediliyor: origin $DEPLOY_BRANCH"
    git push origin "$DEPLOY_BRANCH"
}

detect_compose() {
    if docker compose version >/dev/null 2>&1; then
        COMPOSE_CMD=(docker compose)
        return
    fi

    if command -v docker-compose >/dev/null 2>&1; then
        COMPOSE_CMD=(docker-compose)
        return
    fi

    fail "Docker Compose bulunamadi. 'docker compose' veya 'docker-compose' kurulu olmali."
}

wait_for_url() {
    local url="$1"
    local timeout="$2"
    local started
    local elapsed

    started="$(date +%s)"
    while true; do
        if URL="$url" node -e "fetch(process.env.URL).then(res => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
            success "Health check OK: $url"
            return
        fi

        elapsed="$(($(date +%s) - started))"
        if [ "$elapsed" -ge "$timeout" ]; then
            fail "Health check zaman asimi: $url"
        fi

        sleep 2
    done
}

deploy_local() {
    require_command docker
    detect_compose

    info "Docker Compose deploy basliyor..."
    "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" up -d --build --remove-orphans

    info "Container durumu:"
    "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" ps

    wait_for_url "$DEPLOY_HEALTH_URL" "$DEPLOY_HEALTH_TIMEOUT_SECONDS"
}

ensure_remote_deploy_ready() {
    [ -n "$DEPLOY_REMOTE_HOST" ] || fail "Remote deploy icin DEPLOY_REMOTE_HOST gerekli. Ornek: user@server"
    [ -n "$DEPLOY_REMOTE_PATH" ] || fail "Remote deploy icin DEPLOY_REMOTE_PATH gerekli. Ornek: /opt/WhasAppC"
    require_command ssh

    if ! git diff --quiet || ! git diff --cached --quiet; then
        fail "Remote deploy icin local working tree temiz olmali. Degisiklikleri commit/push edin veya --commit-staged ve --push kullanin."
    fi
}

shell_quote() {
    printf "%q" "$1"
}

deploy_remote() {
    ensure_remote_deploy_ready

    local remote_path_q
    local remote_branch_q
    local compose_file_q
    local compose_service_q
    remote_path_q="$(shell_quote "$DEPLOY_REMOTE_PATH")"
    remote_branch_q="$(shell_quote "$DEPLOY_REMOTE_BRANCH")"
    compose_file_q="$(shell_quote "$COMPOSE_FILE")"
    compose_service_q="$(shell_quote "$COMPOSE_SERVICE")"

    info "Remote deploy basliyor: $DEPLOY_REMOTE_HOST:$DEPLOY_REMOTE_PATH ($DEPLOY_REMOTE_BRANCH)"
    ssh "$DEPLOY_REMOTE_HOST" "set -euo pipefail
cd $remote_path_q
git fetch --prune origin
git checkout $remote_branch_q
git pull --ff-only origin $remote_branch_q

if [ ! -f whatsapp-engine/.env ]; then
    echo 'HATA: whatsapp-engine/.env remote sunucuda yok.' >&2
    exit 1
fi

for var in ADMIN_EMAIL ADMIN_PASS_HASH SESSION_SECRET; do
    if ! grep -q \"^\${var}=.\" whatsapp-engine/.env; then
        echo \"HATA: remote .env icinde eksik zorunlu degisken: \${var}\" >&2
        exit 1
    fi
done

if grep -q '^ADMIN_PASS_HASH=replace-with-bcrypt-hash$' whatsapp-engine/.env; then
    echo 'HATA: remote ADMIN_PASS_HASH placeholder degerinde.' >&2
    exit 1
fi

if grep -q '^SESSION_SECRET=change-me-to-a-long-random-secret$' whatsapp-engine/.env; then
    echo 'HATA: remote SESSION_SECRET placeholder degerinde.' >&2
    exit 1
fi

if docker compose version >/dev/null 2>&1; then
    COMPOSE='docker compose'
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE='docker-compose'
else
    echo 'HATA: remote sunucuda Docker Compose bulunamadi.' >&2
    exit 1
fi

\$COMPOSE -f $compose_file_q up -d --build --remove-orphans
\$COMPOSE -f $compose_file_q ps

deadline=\$((SECONDS + $DEPLOY_HEALTH_TIMEOUT_SECONDS))
while [ \"\$SECONDS\" -lt \"\$deadline\" ]; do
    if \$COMPOSE -f $compose_file_q exec -T $compose_service_q node -e \"fetch('http://127.0.0.1:' + (process.env.PORT || 3005) + '/readyz').then(res => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))\" >/dev/null 2>&1; then
        echo 'Remote container health check OK.'
        exit 0
    fi
    sleep 2
done

echo 'HATA: remote container health check zaman asimi.' >&2
exit 1
"

    if [ -n "$DEPLOY_REMOTE_HEALTH_URL" ]; then
        wait_for_url "$DEPLOY_REMOTE_HEALTH_URL" "$DEPLOY_HEALTH_TIMEOUT_SECONDS"
    else
        warn "DEPLOY_REMOTE_HEALTH_URL verilmedi; remote health check sadece sunucu icindeki local deploy ile sinirli."
    fi
}

main() {
    parse_args "$@"
    run_preflight
    commit_staged_if_requested
    push_if_requested

    case "$DEPLOY_TARGET" in
        local) deploy_local ;;
        remote) deploy_remote ;;
    esac

    info "Current working tree:"
    git status --short

    success "=============================================="
    success "Deploy tamamlandi."
    success "Target: $DEPLOY_TARGET"
    success "=============================================="
}

main "$@"
