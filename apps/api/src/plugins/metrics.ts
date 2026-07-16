import type { FastifyInstance } from 'fastify';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics at /metrics. This endpoint is for internal scraping only —
 * expose it to your monitoring network, never through the public load balancer
 * (see README deployment notes).
 */
export function registerMetrics(app: FastifyInstance): void {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpRequests = new Counter({
    name: 'bagyo_http_requests_total',
    help: 'HTTP requests by route/method/status',
    labelNames: ['route', 'method', 'status'],
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: 'bagyo_http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['route', 'method'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });

  app.addHook('onResponse', (req, reply, done) => {
    const route = req.routeOptions.url ?? 'unmatched';
    if (route !== '/metrics') {
      httpRequests.inc({ route, method: req.method, status: reply.statusCode });
      httpDuration.observe({ route, method: req.method }, reply.elapsedTime / 1000);
    }
    done();
  });

  app.get('/metrics', { schema: { hide: true } }, async (_req, reply) => {
    const body = await registry.metrics();
    return reply.type(registry.contentType).send(body);
  });
}
