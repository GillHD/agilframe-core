# syntax=docker/dockerfile:1
# AgilFrame — production image (server + static demo/editor/dashboard/SDK).
# Build: docker build -t agil-calls:0.1.0 .

FROM node:23-alpine AS build
WORKDIR /app
ENV npm_config_update_notifier=false

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY agil/core/apps ./agil/core/apps
COPY agil/core/packages ./agil/core/packages
COPY agil/core/docs ./agil/core/docs
COPY agil/core/scripts ./agil/core/scripts
COPY agil/websdk ./agil/websdk
COPY agil/mobile ./agil/mobile

RUN npm ci --no-audit --no-fund && npm run build

FROM node:23-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    AGIL_DATA_DIR=/app/.data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY LICENSE NOTICE ./
COPY --from=build /app/agil ./agil
COPY --from=build /app/tsconfig.base.json ./

RUN mkdir -p /app/.data && chown -R node:node /app/.data
USER node
EXPOSE 8787
VOLUME ["/app/.data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "agil/core/apps/server/dist/index.js"]
