import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from '../types.js';

export function registerHealthRoutes(fastify: FastifyInstance, deps: AppDeps): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get(
    '/v1/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Public health check',
        response: { 200: z.object({ status: z.literal('ok'), time: z.string() }) },
      },
    },
    () => Promise.resolve({ status: 'ok' as const, time: new Date().toISOString() }),
  );

  app.get(
    '/ready',
    {
      schema: {
        hide: true,
        response: {
          200: z.object({ status: z.string(), postgres: z.boolean(), redis: z.boolean() }),
          503: z.object({ status: z.string(), postgres: z.boolean(), redis: z.boolean() }),
        },
      },
    },
    async (_req, reply) => {
      const [pg, rd] = await Promise.all([
        deps.prisma.$queryRaw`SELECT 1`.then(
          () => true,
          () => false,
        ),
        deps.redis.ping().then(
          (r) => r === 'PONG',
          () => false,
        ),
      ]);
      const ok = pg && rd;
      return reply
        .status(ok ? 200 : 503)
        .send({ status: ok ? 'ready' : 'degraded', postgres: pg, redis: rd });
    },
  );
}
