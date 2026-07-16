import type { PrismaClient } from '@bagyo/db';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import type { ApiTier, Env } from '@bagyo/shared';

export interface AppDeps {
  prisma: PrismaClient;
  redis: Redis;
  /** Queue used by POST /v1/webhooks/:id/test to enqueue a sample delivery. */
  webhooksQueue: Queue;
  env: Env;
}

export interface AuthContext {
  keyId: string;
  userId: string;
  tier: ApiTier;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}
