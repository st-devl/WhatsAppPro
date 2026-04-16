FROM node:24-bookworm-slim AS deps

WORKDIR /app/whatsapp-engine
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY whatsapp-engine/package*.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3005 \
    WHASAPPC_DATA_DIR=/data

WORKDIR /app/whatsapp-engine

COPY --from=deps /app/whatsapp-engine/node_modules ./node_modules
COPY whatsapp-engine ./

RUN mkdir -p /data uploads auth \
    && chown -R node:node /data /app/whatsapp-engine/uploads /app/whatsapp-engine/auth

USER node

EXPOSE 3005
VOLUME ["/data", "/app/whatsapp-engine/uploads", "/app/whatsapp-engine/auth"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3005) + '/healthz').then(res => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "index.js"]
