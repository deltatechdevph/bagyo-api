import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { getPrisma, disconnectPrisma } from '@bagyo/db';
import { loadEnv, QUEUE_NAMES } from '@bagyo/shared';
import { createLogger } from './logger.js';
import { PoliteFetcher } from './fetcher.js';
import { runBulletinIngest } from './ingest/bulletin-ingest.js';
import { runRainfallIngest } from './ingest/rainfall-ingest.js';
import { createWebhookWorker, createEventFanoutWorker } from './webhooks/dispatcher.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL, 'bagyo-worker');
const prisma = getPrisma();

const connection = () =>
  new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });

const redis = new Redis(env.REDIS_URL);
const fetcher = new PoliteFetcher({ userAgent: env.SCRAPER_USER_AGENT, logger });

const ingestQueue = new Queue(QUEUE_NAMES.ingest, { connection: connection() });
const eventsQueue = new Queue(QUEUE_NAMES.events, { connection: connection() });
const webhooksQueue = new Queue(QUEUE_NAMES.webhooks, { connection: connection() });

/** Bulletin poll gate: 10 min while a cyclone is active, 30 min otherwise. */
async function shouldPollBulletins(): Promise<boolean> {
  const KEY = 'bagyo:ingest:last-poll:bulletins';
  const active = await prisma.cyclone.count({ where: { status: 'ACTIVE' } });
  const interval = (active > 0 ? 10 : 30) * 60_000;
  const last = Number((await redis.get(KEY)) ?? 0);
  if (Date.now() - last < interval - 30_000) return false;
  await redis.set(KEY, String(Date.now()));
  return true;
}

const ingestWorker = new Worker(
  QUEUE_NAMES.ingest,
  async (job) => {
    if (job.name === 'poll-bulletins') {
      if (!(await shouldPollBulletins())) return { skipped: 'interval-gate' };
      return runBulletinIngest({ prisma, redis, fetcher, eventsQueue, env, logger });
    }
    if (job.name === 'poll-rainfall') {
      return runRainfallIngest({ prisma, fetcher, env, logger });
    }
    logger.warn({ name: job.name }, 'unknown ingest job');
    return null;
  },
  { connection: connection(), concurrency: 1 },
);
ingestWorker.on('failed', (job, err) => {
  logger.error({ job: job?.name, err: err.message }, 'ingest job failed');
});

const eventFanout = createEventFanoutWorker({
  prisma,
  logger,
  webhooksQueue,
  connection: connection(),
});
const webhookWorker = createWebhookWorker({
  prisma,
  logger,
  webhooksQueue,
  connection: connection(),
});

async function scheduleJobs(): Promise<void> {
  if (!env.INGEST_ENABLED) {
    logger.info('INGEST_ENABLED=false — live scraping disabled (seed/demo mode)');
    return;
  }
  // Tick every 10 minutes; the gate above stretches to 30 when nothing is active.
  await ingestQueue.upsertJobScheduler(
    'poll-bulletins',
    { every: 10 * 60_000 },
    { name: 'poll-bulletins' },
  );
  await ingestQueue.upsertJobScheduler(
    'poll-rainfall',
    { every: 30 * 60_000 },
    { name: 'poll-rainfall' },
  );
  logger.info('ingestion schedules registered');
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down worker');
  try {
    await Promise.allSettled([ingestWorker.close(), eventFanout.close(), webhookWorker.close()]);
    await Promise.allSettled([ingestQueue.close(), eventsQueue.close(), webhooksQueue.close()]);
    redis.disconnect();
    await disconnectPrisma();
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

scheduleJobs()
  .then(() => logger.info('bagyo worker up'))
  .catch((err: unknown) => {
    logger.error({ err }, 'failed to schedule jobs');
    process.exit(1);
  });
