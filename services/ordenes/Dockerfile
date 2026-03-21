FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM node:20-alpine AS runtime
WORKDIR /app

# Run as non-root user — security best practice.
# Node.js apps don't need root; running as root means any RCE in the app
# immediately has root in the container (container escape risk).
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs src ./src

USER nodejs

ENV NODE_ENV=production
ENV SERVICE_NAME=svc-ordenes

# Health check built into the image — ECS also configures this in the task definition.
# The task definition health check is authoritative; this is a fallback for local runs.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3002/health || exit 1

EXPOSE 3002
CMD ["node", "src/index.js"]
