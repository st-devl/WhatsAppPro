#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

usage() {
    cat <<'USAGE'
Usage:
  ./deploy.sh [--target local|remote] [release.sh options]
  ./deploy.sh --local [release.sh options]
  ./deploy.sh --remote [release.sh options]

deploy.sh is kept only as a compatibility wrapper. The maintained deployment
entrypoint is release.sh.

Mapping:
  --target local, --local     -> ./release.sh local
  --target remote, --remote   -> ./release.sh production
  --bump-patch                -> --version patch
  --commit-staged "message"   -> --commit-all "message"

Examples:
  ./deploy.sh --local --version patch
  DEPLOY_RUNTIME=hostinger-passenger \
  DEPLOY_REMOTE_HOST=user@server \
  DEPLOY_REMOTE_PATH=/home/user/domains/site/public_html/.builds/source/repository \
  DEPLOY_REMOTE_PASSENGER_PATH=/home/user/domains/site/nodejs \
  DEPLOY_REMOTE_HEALTH_URL=https://site/readyz \
  ./deploy.sh --remote --version patch --commit-all "release: production" --push
USAGE
}

target="local"
release_args=()

while [ "$#" -gt 0 ]; do
    case "$1" in
        --target)
            [ "$#" -ge 2 ] || {
                echo "HATA: --target icin local veya remote gerekli." >&2
                exit 1
            }
            target="$2"
            shift 2
            ;;
        --target=*)
            target="${1#*=}"
            shift
            ;;
        --local)
            target="local"
            shift
            ;;
        --remote)
            target="remote"
            shift
            ;;
        --bump-patch)
            release_args+=("--version" "patch")
            shift
            ;;
        --commit-staged)
            [ "$#" -ge 2 ] || {
                echo "HATA: --commit-staged icin commit mesaji gerekli." >&2
                exit 1
            }
            release_args+=("--commit-all" "$2")
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            release_args+=("$1")
            shift
            ;;
    esac
done

case "$target" in
    local)
        exec "$ROOT_DIR/release.sh" local "${release_args[@]}"
        ;;
    remote)
        exec "$ROOT_DIR/release.sh" production "${release_args[@]}"
        ;;
    *)
        echo "HATA: --target local veya remote olmali. Gelen: $target" >&2
        exit 1
        ;;
esac
