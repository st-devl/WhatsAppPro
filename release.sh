#!/usr/bin/env bash
set -euo pipefail

export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
COMPOSE_SERVICE="${COMPOSE_SERVICE:-whasappc}"
DEPLOY_REMOTE_HOST="${DEPLOY_REMOTE_HOST:-}"
DEPLOY_REMOTE_SSH_PORT="${DEPLOY_REMOTE_SSH_PORT:-22}"
DEPLOY_REMOTE_PATH="${DEPLOY_REMOTE_PATH:-}"
DEPLOY_REMOTE_BRANCH="${DEPLOY_REMOTE_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
DEPLOY_REMOTE_REPO_URL="${DEPLOY_REMOTE_REPO_URL:-$(git remote get-url origin 2>/dev/null || echo '')}"
DEPLOY_REMOTE_HEALTH_URL="${DEPLOY_REMOTE_HEALTH_URL:-}"
DEPLOY_HEALTH_TIMEOUT_SECONDS="${DEPLOY_HEALTH_TIMEOUT_SECONDS:-90}"
DEPLOY_RUNTIME="${DEPLOY_RUNTIME:-docker}"
DEPLOY_REMOTE_RESTART_CMD="${DEPLOY_REMOTE_RESTART_CMD:-}"

MODE="check"
VERSION_BUMP="none"
COMMIT_ALL_MESSAGE=""
PUSH_AFTER_COMMIT=0
SKIP_TESTS=0
SKIP_AUDIT=0
SKIP_CSS_BUILD=0

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

usage() {
    cat <<'USAGE'
Usage:
  ./release.sh check
  ./release.sh local --version patch
  ./release.sh production --version patch --commit-all "release: ..." --push

Modes:
  check          Run release checks, generate manifest, do not deploy. Default.
  local          Run checks and deploy locally with Docker Compose.
  production     Run checks, require pushed commit, deploy remote over SSH.

Options:
  --version none|patch|minor|major   Bump whatsapp-engine version. Default: none.
  --commit-all "message"             Stage all repo changes and commit after checks.
  --push                             Push current branch to origin after commit/checks.
  --skip-tests                       Skip npm test.
  --skip-audit                       Skip npm audit --omit=dev.
  --skip-css-build                   Skip Tailwind CSS build.
  -h, --help                         Show this help.

Remote environment:
  DEPLOY_REMOTE_HOST                 Example: user@1.2.3.4
  DEPLOY_REMOTE_SSH_PORT             Default: 22
  DEPLOY_REMOTE_PATH                 Example: /opt/WhasAppC
  DEPLOY_REMOTE_BRANCH               Default: current branch
  DEPLOY_REMOTE_REPO_URL             Default: local origin URL
  DEPLOY_REMOTE_HEALTH_URL           Optional public health URL
  DEPLOY_RUNTIME                     docker or node. Default: docker
  DEPLOY_REMOTE_RESTART_CMD          Required for node runtime unless PM2 can be auto-detected
  COMPOSE_FILE                       Default: docker-compose.yml
  COMPOSE_SERVICE                    Default: whasappc

Notes:
  production mode never overwrites dirty files on the server. It stops if the
  remote working tree has uncommitted changes. Use DEPLOY_RUNTIME=node for
  shared hosting servers where Docker Compose is not available.
USAGE
}

info() { echo -e "${BLUE}$*${NC}"; }
success() { echo -e "${GREEN}$*${NC}"; }
warn() { echo -e "${YELLOW}$*${NC}"; }
fail() { echo -e "${RED}HATA: $*${NC}" >&2; exit 1; }

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "$1 bulunamadi."
}

step() {
    info ""
    info "[$1] $2"
}

parse_args() {
    if [ "$#" -gt 0 ]; then
        case "$1" in
            check|local|production|remote)
                MODE="$1"
                [ "$MODE" = "remote" ] && MODE="production"
                shift
                ;;
        esac
    fi

    while [ "$#" -gt 0 ]; do
        case "$1" in
            --version)
                [ "$#" -ge 2 ] || fail "--version icin none, patch, minor veya major gerekli."
                VERSION_BUMP="$2"
                shift 2
                ;;
            --version=*)
                VERSION_BUMP="${1#*=}"
                shift
                ;;
            --commit-all)
                [ "$#" -ge 2 ] || fail "--commit-all icin commit mesaji gerekli."
                COMMIT_ALL_MESSAGE="$2"
                shift 2
                ;;
            --push)
                PUSH_AFTER_COMMIT=1
                shift
                ;;
            --skip-tests)
                SKIP_TESTS=1
                shift
                ;;
            --skip-audit)
                SKIP_AUDIT=1
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

    case "$MODE" in
        check|local|production) ;;
        *) fail "Mode check, local veya production olmali. Gelen: $MODE" ;;
    esac

    case "$VERSION_BUMP" in
        none|patch|minor|major) ;;
        *) fail "--version none, patch, minor veya major olmali. Gelen: $VERSION_BUMP" ;;
    esac
}

env_value() {
    local file="$1"
    local key="$2"
    grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- || true
}

validate_env_file() {
    local file="whatsapp-engine/.env"
    local example="whatsapp-engine/.env.example"

    if [ ! -f "$file" ]; then
        [ -f "$example" ] || fail "$file bulunamadi ve ornek env yok."
        fail "$file bulunamadi. Once $example dosyasindan production degerleriyle olusturun."
    fi

    local missing=""
    local key
    for key in ADMIN_EMAIL ADMIN_PASS_HASH SESSION_SECRET; do
        [ -n "$(env_value "$file" "$key")" ] || missing="$missing $key"
    done
    [ -z "$missing" ] || fail "$file icinde eksik zorunlu degiskenler:$missing"

    local session_secret
    session_secret="$(env_value "$file" "SESSION_SECRET")"
    [ "$session_secret" != "change-me-to-a-long-random-secret" ] || fail "SESSION_SECRET placeholder degerinde."
    [ "${#session_secret}" -ge 32 ] || fail "SESSION_SECRET en az 32 karakter olmali."

    local pass_hash
    pass_hash="$(env_value "$file" "ADMIN_PASS_HASH")"
    [ "$pass_hash" != "replace-with-bcrypt-hash" ] || fail "ADMIN_PASS_HASH placeholder degerinde."
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
    fail "Docker Compose bulunamadi."
}

validate_runtime() {
    case "$DEPLOY_RUNTIME" in
        docker|node) ;;
        *) fail "DEPLOY_RUNTIME docker veya node olmali. Gelen: $DEPLOY_RUNTIME" ;;
    esac
}

wait_for_url() {
    local url="$1"
    local timeout="$2"
    local started
    started="$(date +%s)"

    while true; do
        if URL="$url" node -e "fetch(process.env.URL).then(res => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
            success "Health check OK: $url"
            return
        fi
        if [ "$(($(date +%s) - started))" -ge "$timeout" ]; then
            fail "Health check zaman asimi: $url"
        fi
        sleep 2
    done
}

run_preflight() {
    step "1/8" "Preflight"
    require_command git
    require_command node
    require_command npm
    validate_env_file
    validate_runtime

    node -e "const major = Number(process.versions.node.split('.')[0]); if (major < 20 || major >= 26) { console.error('Node.js >=20 <26 required. Current: ' + process.version); process.exit(1); }"
    git diff --check
    git diff --cached --check
}

bump_version_if_requested() {
    step "2/8" "Version"
    if [ "$VERSION_BUMP" = "none" ]; then
        info "Version bump atlandi."
        return
    fi
    npm --prefix whatsapp-engine version "$VERSION_BUMP" --no-git-tag-version
}

build_and_verify() {
    step "3/8" "Frontend build"
    if [ "$SKIP_CSS_BUILD" -eq 1 ]; then
        warn "CSS build atlandi."
    else
        npm --prefix whatsapp-engine run build:css
    fi

    step "4/8" "Release manifest"
    npm --prefix whatsapp-engine run release:manifest -- --environment "$MODE"

    step "5/8" "Migration status"
    npm --prefix whatsapp-engine run migrate:status

    step "6/8" "Tests"
    if [ "$SKIP_TESTS" -eq 1 ]; then
        warn "Testler atlandi."
    else
        npm test
    fi

    step "7/8" "Security audit"
    if [ "$SKIP_AUDIT" -eq 1 ]; then
        warn "Audit atlandi."
    else
        npm --prefix whatsapp-engine audit --omit=dev
    fi
}

commit_and_push_if_requested() {
    if [ -n "$COMMIT_ALL_MESSAGE" ]; then
        step "8/8" "Commit"
        git add -A
        if git diff --cached --quiet; then
            warn "Commit edilecek degisiklik yok."
        else
            git commit -m "$COMMIT_ALL_MESSAGE"
        fi
    fi

    if [ "$PUSH_AFTER_COMMIT" -eq 1 ]; then
        local branch
        branch="$(git rev-parse --abbrev-ref HEAD)"
        info "Push: origin $branch"
        git push origin "$branch"
    fi
}

ensure_remote_inputs() {
    [ -n "$DEPLOY_REMOTE_HOST" ] || fail "DEPLOY_REMOTE_HOST gerekli."
    [ -n "$DEPLOY_REMOTE_PATH" ] || fail "DEPLOY_REMOTE_PATH gerekli."
    [ -n "$DEPLOY_REMOTE_REPO_URL" ] || fail "DEPLOY_REMOTE_REPO_URL gerekli."
    require_command ssh

    if ! git diff --quiet || ! git diff --cached --quiet; then
        fail "Production deploy icin local working tree temiz olmali. --commit-all ve --push kullanin veya once manuel commit/push yapin."
    fi

    local commit
    local remote_commit
    commit="$(git rev-parse HEAD)"
    remote_commit="$(git ls-remote origin "refs/heads/$DEPLOY_REMOTE_BRANCH" | awk '{print $1}')"
    [ "$remote_commit" = "$commit" ] || fail "Origin/$DEPLOY_REMOTE_BRANCH son commit ile ayni degil. --push kullanin."
}

shell_quote() {
    printf "%q" "$1"
}

deploy_local() {
    require_command docker
    detect_compose

    info "Local Docker image build ediliyor..."
    "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" build "$COMPOSE_SERVICE"
    info "Local migration apply calisiyor..."
    "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" run --rm --no-deps "$COMPOSE_SERVICE" npm run migrate:apply
    info "Local servis baslatiliyor..."
    "${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" up -d --remove-orphans "$COMPOSE_SERVICE"
    wait_for_url "http://127.0.0.1:3005/readyz" "$DEPLOY_HEALTH_TIMEOUT_SECONDS"
}

deploy_remote() {
    ensure_remote_inputs

    local commit
    local remote_path_q
    local branch_q
    local repo_url_q
    local compose_file_q
    local compose_service_q
    commit="$(git rev-parse HEAD)"
    remote_path_q="$(shell_quote "$DEPLOY_REMOTE_PATH")"
    branch_q="$(shell_quote "$DEPLOY_REMOTE_BRANCH")"
    repo_url_q="$(shell_quote "$DEPLOY_REMOTE_REPO_URL")"
    compose_file_q="$(shell_quote "$COMPOSE_FILE")"
    compose_service_q="$(shell_quote "$COMPOSE_SERVICE")"

    local restart_cmd_q
    restart_cmd_q="$(shell_quote "$DEPLOY_REMOTE_RESTART_CMD")"

    info "Remote deploy: $DEPLOY_REMOTE_HOST:$DEPLOY_REMOTE_PATH commit=$commit runtime=$DEPLOY_RUNTIME"
    ssh -p "$DEPLOY_REMOTE_SSH_PORT" "$DEPLOY_REMOTE_HOST" "set -euo pipefail
remote_path=$remote_path_q
if [ ! -d \"\$remote_path\" ]; then
    if ! command -v git >/dev/null 2>&1; then
        echo 'HATA: remote git bulunamadi.' >&2
        exit 1
    fi
    remote_parent=\$(dirname \"\$remote_path\")
    mkdir -p \"\$remote_parent\"
    git clone --branch $branch_q $repo_url_q \"\$remote_path\"
fi
cd \"\$remote_path\"
if [ ! -d .git ]; then
    echo 'HATA: DEPLOY_REMOTE_PATH bir git repository degil.' >&2
    exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo 'HATA: remote working tree temiz degil.' >&2
    git status --short >&2
    exit 1
fi
git fetch --prune origin
git checkout $branch_q
git pull --ff-only origin $branch_q
actual_commit=\$(git rev-parse HEAD)
if [ \"\$actual_commit\" != \"$commit\" ]; then
    echo \"HATA: remote commit beklenen commit degil. Beklenen $commit gelen \$actual_commit\" >&2
    exit 1
fi
node whatsapp-engine/scripts/release-manifest.js --environment production --commit \"$commit\"

if [ \"$DEPLOY_RUNTIME\" = 'node' ]; then
    if ! command -v node >/dev/null 2>&1; then
        echo 'HATA: remote node bulunamadi.' >&2
        exit 1
    fi
    if ! command -v npm >/dev/null 2>&1; then
        echo 'HATA: remote npm bulunamadi.' >&2
        exit 1
    fi

    node -e \"const major = Number(process.versions.node.split('.')[0]); if (major < 20 || major >= 26) { console.error('Node.js >=20 <26 required. Current: ' + process.version); process.exit(1); }\"
    if [ ! -f whatsapp-engine/package-lock.json ]; then
        if ! git show HEAD:whatsapp-engine/package-lock.json > whatsapp-engine/package-lock.json; then
            echo 'HATA: whatsapp-engine/package-lock.json remote checkout icinde yok ve committen geri yuklenemedi.' >&2
            exit 1
        fi
    fi
    old_node_modules=''
    failed_node_modules=''
    if [ -d whatsapp-engine/node_modules ]; then
        old_node_modules=\"whatsapp-engine/.node_modules-old-\$(date +%s)\"
        mv whatsapp-engine/node_modules \"\$old_node_modules\"
    fi
    rm -rf .npm-release-cache || true
    if ! npm --prefix whatsapp-engine ci --omit=dev --cache \"\$PWD/.npm-release-cache\" --prefer-online --no-audit --no-fund; then
        echo 'HATA: npm ci basarisiz oldu. Eski node_modules geri yuklenecek.' >&2
        failed_node_modules=\"whatsapp-engine/.node_modules-failed-\$(date +%s)\"
        if [ -d whatsapp-engine/node_modules ]; then
            mv whatsapp-engine/node_modules \"\$failed_node_modules\" || true
        fi
        if [ -n \"\$old_node_modules\" ] && [ -d \"\$old_node_modules\" ]; then
            mv \"\$old_node_modules\" whatsapp-engine/node_modules || true
        fi
        exit 1
    fi
    if [ -n \"\$old_node_modules\" ] && [ -d \"\$old_node_modules\" ]; then
        rm -rf \"\$old_node_modules\" || true
    fi
    npm --prefix whatsapp-engine run migrate:apply

    if [ -n $restart_cmd_q ]; then
        eval $restart_cmd_q
    elif command -v pm2 >/dev/null 2>&1; then
        pm2 reload whasappc || pm2 restart whasappc || pm2 reload yardimet.site || pm2 restart yardimet.site || pm2 start whatsapp-engine/index.js --name whasappc
        pm2 save || true
    else
        echo 'HATA: node runtime icin restart yontemi bulunamadi.' >&2
        echo 'DEPLOY_REMOTE_RESTART_CMD ayarlayin veya sunucuda PM2 kullanin.' >&2
        exit 1
    fi
else
    if docker compose version >/dev/null 2>&1; then
        COMPOSE='docker compose'
    elif command -v docker-compose >/dev/null 2>&1; then
        COMPOSE='docker-compose'
    else
        echo 'HATA: remote Docker Compose bulunamadi. Bu sunucu icin DEPLOY_RUNTIME=node kullanin.' >&2
        exit 1
    fi

    \$COMPOSE -f $compose_file_q build $compose_service_q
    \$COMPOSE -f $compose_file_q run --rm --no-deps $compose_service_q npm run migrate:apply
    \$COMPOSE -f $compose_file_q up -d --remove-orphans $compose_service_q
fi

deadline=\$((SECONDS + $DEPLOY_HEALTH_TIMEOUT_SECONDS))
while [ \"\$SECONDS\" -lt \"\$deadline\" ]; do
    if [ \"$DEPLOY_RUNTIME\" = 'docker' ]; then
        \$COMPOSE -f $compose_file_q exec -T $compose_service_q node -e \"fetch('http://127.0.0.1:' + (process.env.PORT || 3005) + '/readyz').then(res => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))\" >/dev/null 2>&1 && {
            echo 'Remote container health check OK.'
            exit 0
        }
    elif node -e \"fetch('http://127.0.0.1:' + (process.env.PORT || 3005) + '/readyz').then(res => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))\" >/dev/null 2>&1; then
        echo 'Remote container health check OK.'
        exit 0
    fi
    sleep 2
done

echo 'HATA: remote health check zaman asimi.' >&2
exit 1
"

    if [ -n "$DEPLOY_REMOTE_HEALTH_URL" ]; then
        wait_for_url "$DEPLOY_REMOTE_HEALTH_URL" "$DEPLOY_HEALTH_TIMEOUT_SECONDS"
    else
        warn "DEPLOY_REMOTE_HEALTH_URL verilmedi; public URL dogrulamasi atlandi."
    fi
}

main() {
    parse_args "$@"
    run_preflight
    bump_version_if_requested
    build_and_verify
    commit_and_push_if_requested

    case "$MODE" in
        check)
            success "Release check tamamlandi. Deploy yapilmadi."
            ;;
        local)
            deploy_local
            success "Local deploy tamamlandi."
            ;;
        production)
            deploy_remote
            success "Production deploy tamamlandi."
            ;;
    esac
}

main "$@"
