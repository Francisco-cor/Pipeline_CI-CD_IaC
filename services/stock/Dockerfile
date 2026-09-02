FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY services/productos/package.json ./services/productos/package.json
COPY services/ordenes/package.json ./services/ordenes/package.json
COPY services/stock/package.json ./services/stock/package.json
COPY migrations/package.json ./migrations/package.json
COPY packages/shared/src ./packages/shared/src
COPY services/stock/src ./services/stock/src
RUN npm ci --ignore-scripts

FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=nodejs:nodejs /app/packages/shared ./packages/shared
COPY --from=deps --chown=nodejs:nodejs /app/services/stock/package.json ./services/stock/package.json
COPY --chown=nodejs:nodejs services/stock/src ./services/stock/src
COPY --chown=nodejs:nodejs packages/shared/src ./packages/shared/src
# Fase 8.2 — CA bundle para RDS TLS en prod
COPY --chown=nodejs:nodejs certs/rds-ca-bundle.pem /app/certs/rds-ca-bundle.pem

WORKDIR /app/services/stock

USER nodejs

ENV NODE_ENV=production
ENV SERVICE_NAME=svc-stock

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3003/health || exit 1

EXPOSE 3003
CMD ["node", "src/index.js"]
