FROM node:26-alpine
WORKDIR /app

# Run as non-root user — security best practice even for init containers.
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Fase 7: context root para incluir certs + shared (Fase 8.2)
COPY --chown=nodejs:nodejs migrations/package*.json ./
RUN npm ci --only=production

COPY --chown=nodejs:nodejs migrations/run.js ./run.js
COPY --chown=nodejs:nodejs migrations/sql ./sql
# Fase 8.2 — CA bundle para RDS TLS en prod
COPY --chown=nodejs:nodejs certs/rds-ca-bundle.pem ./certs/rds-ca-bundle.pem
COPY --chown=nodejs:nodejs certs/rds-ca-bundle.pem /app/certs/rds-ca-bundle.pem

USER nodejs

# This container exits after running migrations.
# ECS uses dependsOn with condition: "SUCCESS" to gate other containers on this.
# Exit 0 → all services start. Exit non-0 → task fails → circuit breaker fires.
CMD ["node", "run.js"]
