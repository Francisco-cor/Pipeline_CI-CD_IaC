FROM nginx:1.25-alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

COPY nginx.conf /etc/nginx/nginx.conf

# Health check — ECS also checks /health via the task definition healthCheck block.
# This HEALTHCHECK directive is used when running the container locally with docker run.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost/health || exit 1

EXPOSE 80
