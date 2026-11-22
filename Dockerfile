FROM node:24.22.2-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM build AS migration
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "status"]

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
COPY --from=production-dependencies /app/package.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY ops/healthcheck.mjs ./healthcheck.mjs
USER node
EXPOSE 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "healthcheck.mjs"]
CMD ["node","dist/src/server.js"]
