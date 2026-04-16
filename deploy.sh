#!/bin/bash
set -euo pipefail

export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ENV_FILE="whatsapp-engine/.env"
ENV_EXAMPLE="whatsapp-engine/.env.example"

echo -e "${BLUE}==============================================${NC}"
echo -e "${BLUE}   WhasAppC deployment preflight              ${NC}"
echo -e "${BLUE}==============================================${NC}"

# .env kontrolü
if [ ! -f "$ENV_FILE" ]; then
    echo -e "${YELLOW}UYARI: $ENV_FILE bulunamadi!${NC}"
    if [ -f "$ENV_EXAMPLE" ]; then
        cp "$ENV_EXAMPLE" "$ENV_FILE"
        echo -e "${YELLOW}ornek dosyadan .env olusturuldu. LUTFEN bilgilerinizi girin:${NC}"
        echo -e "${YELLOW}  nano $ENV_FILE${NC}"
        echo -e "${YELLOW}Ozellikle ADMIN_EMAIL ve ADMIN_PASS_HASH zorunludur.${NC}"
        echo ""
        echo -e "${YELLOW}Sifre hash'i olusturmak icin:${NC}"
        echo -e "  node -e \"require('bcryptjs').hash('SIFRENIZ', 10).then(h => console.log(h))\""
        echo ""
        exit 1
    else
        echo -e "${YELLOW}.env.example da bulunamadi. Lutfen manuel olusturun.${NC}"
        exit 1
    fi
fi

# .env icinde zorunlu degiskenler kontrolu
REQUIRED_VARS="ADMIN_EMAIL ADMIN_PASS_HASH SESSION_SECRET"
MISSING=""
for var in $REQUIRED_VARS; do
    if ! grep -q "^${var}=" "$ENV_FILE" || grep -q "^${var}=$" "$ENV_FILE"; then
        MISSING="$MISSING $var"
    fi
done

if [ -n "$MISSING" ]; then
    echo -e "${YELLOW}UYARI: .env dosyasinda eksik zorunlu degiskenler:$MISSING${NC}"
    echo -e "${YELLOW}Lutfen duzeltin: nano $ENV_FILE${NC}"
    exit 1
fi

echo -e "${GREEN}.env dosyasi kontrolu: OK${NC}"

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
