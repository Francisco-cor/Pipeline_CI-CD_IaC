FROM node:20-alpine AS deps
WORKDIR /app
# Copy workspace manifests first for layer cache
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY services/productos/package.json ./services/productos/package.json
COPY services/ordenes/package.json ./services/ordenes/package.json
COPY services/stock/package.json ./services/stock/package.json
COPY migrations/package.json ./migrations/package.json
# Copy shared src (needed for workspace link)
COPY packages/shared/src ./packages/shared/src
# Copy service src for npm ci to resolve workspace (optional)
COPY services/productos/src ./services/productos/src
RUN npm ci --ignore-scripts

FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=nodejs:nodejs /app/packages/shared ./packages/shared
COPY --from=deps --chown=nodejs:nodejs /app/services/productos/package.json ./services/productos/package.json
COPY --chown=nodejs:nodejs services/productos/src ./services/productos/src
COPY --chown=nodejs:nodejs packages/shared/src ./packages/shared/src

WORKDIR /app/services/productos

USER nodejs

ENV NODE_ENV=production
ENV SERVICE_NAME=svc-productos

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

EXPOSE 3001
CMD ["node", "src/index.js"]
