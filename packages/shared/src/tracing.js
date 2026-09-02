'use strict';

// SPDX-License-Identifier: MIT
// Fase 9.6 — OpenTelemetry tracing → X-Ray/OTel collector
// Uso: const { initTracing } = require('@erp/shared'); initTracing('svc-productos');
// Env vars:
//   OTEL_ENABLED=false              — deshabilita tracing (default false en dev para no ruido)
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces — OTel collector / Jaeger / X-Ray via ADOT
//   OTEL_SERVICE_NAME=svc-productos — override
//   TRACE_SAMPLE_RATIO=0.1          — 10% sampling en prod para coste

let sdk;

function initTracing(serviceName) {
  const enabled = String(process.env.OTEL_ENABLED || '').toLowerCase() === 'true';
  if (!enabled) {
    return null;
  }

  // Lazy require para no romper si deps no instaladas en algún env
  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { Resource } = require('@opentelemetry/resources');
    const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

    const svc =
      serviceName || process.env.OTEL_SERVICE_NAME || process.env.SERVICE_NAME || 'unknown';

    const exporter = new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
    });

    const sampleRatio = Number(process.env.TRACE_SAMPLE_RATIO || '0.1');

    sdk = new NodeSDK({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: svc,
        [SemanticResourceAttributes.SERVICE_VERSION]: process.env.APP_VERSION || 'dev',
        [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]:
          process.env.ENVIRONMENT || process.env.NODE_ENV || 'dev',
      }),
      traceExporter: exporter,
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-dns': { enabled: false },
        }),
      ],
      // Simple sampler — ParentBased con ratio
      // Si no se especifica, OTel usa ParentBased AlwaysOn; usamos ratio para prod
      sampler: (() => {
        try {
          const {
            ParentBasedSampler,
            TraceIdRatioBasedSampler,
          } = require('@opentelemetry/sdk-trace-base');
          return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRatio) });
        } catch (_e) {
          return undefined;
        }
      })(),
    });

    sdk.start();
    // Graceful shutdown
    process.on('SIGTERM', () => {
      sdk
        .shutdown()
        .then(() => {})
        .catch(() => {})
        .finally(() => process.exit(0));
    });

    // Log correlation — opcional, OTel inyecta traceId en contexto
    // No usamos console.log para no spamear; el logger ya incluye requestId
    return sdk;
  } catch (err) {
    // No romper el arranque si OTel falla (ej. deps no instaladas)
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        service: serviceName,
        message: 'OTel init failed — tracing disabled',
        error: err.message,
      })
    );
    return null;
  }
}

function shutdownTracing() {
  if (sdk) return sdk.shutdown();
  return Promise.resolve();
}

module.exports = { initTracing, shutdownTracing };
