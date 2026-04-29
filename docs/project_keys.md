./deploy.sh


DEPLOY_RUNTIME=node \
DEPLOY_REMOTE_HOST=u341720642@141.136.43.125 \
DEPLOY_REMOTE_SSH_PORT=65002 \
DEPLOY_REMOTE_PATH=/home/u341720642/domains/yardimet.site/public_html/.builds/source/repository \
./release.sh production --version patch --commit-all "release: recover remote partial deploy state" --push
