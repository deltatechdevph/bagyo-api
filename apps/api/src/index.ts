import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { getPrisma, disconnectPrisma } from '@bagyo/db';
import { loadEnv, QUEUE_NAMES } from '@bagyo/shared';
import { buildApp } from './app.js';

const env = loadEnv();
const prisma = getPrisma();
const redis = new Redis(env.REDIS_URL);
const webhooksQueue = new Queue(QUEUE_NAMES.webhooks, {
  connection: new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
});

const app = await buildApp({ prisma, redis, webhooksQueue, env });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'draining connections and shutting down');
  try {
    await app.close(); // stops accepting, waits for in-flight requests
    await webhooksQueue.close();
    redis.disconnect();
    await disconnectPrisma();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  app.log.info(`docs at http://${env.API_HOST}:${env.API_PORT}/docs`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
