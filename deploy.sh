#!/bin/bash
set -euo pipefail

export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}==============================================${NC}"
echo -e "${BLUE}   WhasAppC deployment preflight              ${NC}"
echo -e "${BLUE}==============================================${NC}"

if [ "${1:-}" = "--bump-patch" ]; then
    echo -e "${YELLOW}Bumping whatsapp-engine patch version without git tag...${NC}"
    npm --prefix whatsapp-engine version patch --no-git-tag-version
fi

echo -e "${BLUE}Running whitespace checks...${NC}"
git diff --check

echo -e "${BLUE}Checking Node.js runtime compatibility...${NC}"
node -e "const major = Number(process.versions.node.split('.')[0]); if (major < 20 || major >= 26) { console.error('Node.js >=20 <26 required. Current: ' + process.version); process.exit(1); }"

echo -e "${BLUE}Running application verification...${NC}"
npm --prefix whatsapp-engine test

echo -e "${BLUE}Current working tree:${NC}"
git status --short

echo -e "${GREEN}==============================================${NC}"
echo -e "${GREEN}Preflight completed.${NC}"
echo -e "${GREEN}Review the diff, commit intentionally, then push with an explicit git command.${NC}"
echo -e "${GREEN}This script does not run git add, git commit, or git push.${NC}"
echo -e "${GREEN}==============================================${NC}"
