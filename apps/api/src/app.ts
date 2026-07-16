import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { ATTRIBUTION, DISCLAIMER } from '@bagyo/shared';
import type { AppDeps } from './types.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerAuth } from './plugins/auth.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { registerMetrics } from './plugins/metrics.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerCycloneRoutes } from './routes/cyclones.js';
import { registerSignalRoutes } from './routes/signals.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerAccountRoutes } from './routes/account.js';

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.env.NODE_ENV === 'test' ? 'silent' : deps.env.LOG_LEVEL,
      ...(deps.env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
      redact: ['req.headers.authorization'],
    },
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    trustProxy: true,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    // The API returns JSON only; keep CSP for /docs (Swagger UI) permissive enough to render.
    contentSecurityPolicy: false,
  });

  // Pure API routes are open (key auth is the gate); dashboard-ish routes
  // (account/keys/webhooks management from a browser) are locked to configured origins.
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / server-to-server
      if (deps.env.CORS_ORIGINS.length === 0) return cb(null, false);
      cb(null, deps.env.CORS_ORIGINS.includes(origin));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });

  app.addHook('onSend', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'BagyoAPI',
        description:
          `PAGASA tropical cyclone bulletins as clean JSON. Source: ${ATTRIBUTION}. ` +
          `Disclaimer: ${DISCLAIMER}`,
        version: '1.0.0',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          apiKey: {
            type: 'http',
            scheme: 'bearer',
            description: 'API key, e.g. `Authorization: Bearer bgy_live_…`',
          },
        },
      },
      security: [{ apiKey: [] }],
      tags: [
        { name: 'cyclones' },
        { name: 'bulletins' },
        { name: 'signals' },
        { name: 'rainfall' },
        { name: 'webhooks' },
        { name: 'account' },
        { name: 'system' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  registerErrorHandler(app);
  registerAuth(app, deps);
  registerRateLimit(app, deps);
  registerMetrics(app);

  registerHealthRoutes(app, deps);
  registerCycloneRoutes(app, deps);
  registerSignalRoutes(app, deps);
  registerWebhookRoutes(app, deps);
  registerAccountRoutes(app, deps);

  return app;
}
