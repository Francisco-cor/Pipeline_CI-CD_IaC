FROM node:20-alpine
WORKDIR /app

# Run as non-root user — security best practice even for init containers.
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --chown=nodejs:nodejs package*.json ./
RUN npm ci --only=production

COPY --chown=nodejs:nodejs . .

USER nodejs

# This container exits after running migrations.
# ECS uses dependsOn with condition: "SUCCESS" to gate other containers on this.
# Exit 0 → all services start. Exit non-0 → task fails → circuit breaker fires.
CMD ["node", "run.js"]
