#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    cat <<'USAGE'
Usage:
  ./deploy.sh [--with-tests] [--skip-css-build] [--setup-env]
  ./deploy.sh --legacy-release [release.sh production options]

Default behavior deploys to the configured Hostinger Passenger production app.
It does not require a clean git tree, does not push to GitHub, and preserves
remote .env plus runtime data.

Daily production deploy:
  ./deploy.sh

First production setup when remote .env is missing:
  ./deploy.sh --setup-env

Safer production deploy with tests:
  ./deploy.sh --with-tests

USAGE
}

if [ "$#" -gt 0 ]; then
    case "$1" in
        --legacy-release)
            shift
            exec "$ROOT_DIR/release.sh" production "$@"
            ;;
        -h|--help)
            usage
            exit 0
            ;;
    esac
fi

exec "$ROOT_DIR/deploy-production.sh" "$@"
