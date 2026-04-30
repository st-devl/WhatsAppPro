./deploy.sh


DEPLOY_RUNTIME=node \
DEPLOY_REMOTE_HOST=u341720642@141.136.43.125 \
DEPLOY_REMOTE_SSH_PORT=65002 \
DEPLOY_REMOTE_PATH=/home/u341720642/domains/yardimet.site/public_html/.builds/source/repository \
DEPLOY_REMOTE_HEALTH_URL="https://yardimet.site/api/healthz" \
./release.sh production --version patch --commit-all "release: ship node modules bundle" --push
