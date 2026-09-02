'use strict';

// SPDX-License-Identifier: MIT
// Fase 9.3 — Metrics: prom-client + CloudWatch EMF
// Expone /metrics para Prometheus scrape y loggea EMF para CloudWatch Metrics via Logs

const client = require('prom-client');

// Registry único por proceso — evita duplicar en hot-reload
let registry;
function getRegistry() {
  if (!registry) {
    registry = new client.Registry();
    client.collectDefaultMetrics({ register: registry, prefix: 'erp_' });
  }
  return registry;
}

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request latency in ms',
  labelNames: ['method', 'route', 'status'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  registers: [getRegistry()],
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [getRegistry()],
});

const activeRequests = new client.Gauge({
  name: 'http_active_requests',
  help: 'Active HTTP requests',
  registers: [getRegistry()],
});

// Middleware que mide duración y loggea EMF para CloudWatch
function metricsMiddleware(req, res, next) {
  const start = Date.now();
  activeRequests.inc();

  // Normaliza ruta para labels (evita cardinalidad alta en /:id)
  const route =
    (req.route && req.route.path) ||
    req.path.split('?')[0].replace(/\/\d+(\/|$)/g, '/:id$1') ||
    req.path;

  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = String(res.statusCode);
    const method = req.method;
    const labels = { method, route, status };

    httpRequestDuration.observe(labels, ms);
    httpRequestsTotal.inc(labels);
    activeRequests.dec();

    // Fase 9.3 — EMF para CloudWatch Metrics via Logs
    // CloudWatch extrae métricas automáticamente si el JSON tiene _aws key
    // Ver: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
    try {
      const emf = {
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: `${process.env.PROJECT_NAME || 'erp-pipeline'}/${process.env.ENVIRONMENT || process.env.NODE_ENV || 'dev'}`,
              Dimensions: [['ServiceName', 'Route']],
              Metrics: [
                { Name: 'HttpLatency', Unit: 'Milliseconds' },
                { Name: 'HttpRequestCount', Unit: 'Count' },
              ],
            },
          ],
        },
        ServiceName: process.env.SERVICE_NAME || 'unknown',
        Route: route,
        HttpLatency: ms,
        HttpRequestCount: 1,
        StatusCode: res.statusCode,
        Method: method,
      };
      // Loggear EMF como JSON — CloudWatch lo interpreta como métrica si va a log group /ecs/*
      // Usamos console.log directo para no pasar por logger que añade timestamp/level extra
      // Pero logger también lo captura; lo hacemos via stdout JSON con _aws
      process.stdout.write(JSON.stringify(emf) + '\n');
    } catch (_e) {
      // ignore EMF errors
    }
  });

  next();
}

// Handler para GET /metrics — Prometheus scrape
async function metricsHandler(_req, res) {
  res.set('Content-Type', getRegistry().contentType);
  res.end(await getRegistry().metrics());
}

module.exports = {
  getRegistry,
  httpRequestDuration,
  httpRequestsTotal,
  activeRequests,
  metricsMiddleware,
  metricsHandler,
};
