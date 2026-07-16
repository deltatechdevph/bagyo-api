/**
 * Worker integration tests — require Postgres (migrated) and Redis:
 *   docker compose up -d postgres redis && pnpm db:migrate
 * CI provides both as services.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue, type Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { PrismaClient } from '@bagyo/db';
import {
  QUEUE_NAMES,
  verifyWebhookSignature,
  WEBHOOK_RETRY_DELAYS_MS,
  type DomainEvent,
} from '@bagyo/shared';
import { parseBulletinPdf, PARSER_VERSION } from '@bagyo/parser';
import { persistBulletin, sha256 } from '@bagyo/ingest';
import {
  createEventFanoutWorker,
  createWebhookWorker,
  retryDelayFor,
} from './webhooks/dispatcher.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://bagyo:bagyo@localhost:5432/bagyo?schema=public';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const FIX = join(import.meta.dirname, '../../../fixtures');

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const logger = pino({ level: 'silent' });
let redis: Redis;
let eventsQueue: Queue;
let webhooksQueue: Queue;
const workers: Worker[] = [];

async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "WebhookDelivery","WebhookSubscription","WindSignal","Bulletin","Cyclone","RainfallAdvisory","IngestRun","ApiKey","User" CASCADE',
  );
}

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.ping();
  await prisma.$queryRaw`SELECT 1`;
  eventsQueue = new Queue(QUEUE_NAMES.events, { connection: redis });
  webhooksQueue = new Queue(QUEUE_NAMES.webhooks, { connection: redis });
});

afterAll(async () => {
  for (const w of workers) await w.close();
  await eventsQueue?.close();
  await webhooksQueue?.close();
  redis?.disconnect();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll();
  await eventsQueue.drain(true);
  await webhooksQueue.drain(true);
});

const conn = () => new Redis(REDIS_URL, { maxRetriesPerRequest: null });

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('persistBulletin idempotency (real parser + real DB)', () => {
  it('ingesting the same bulletin twice produces zero new rows', async () => {
    const pdf = new Uint8Array(readFileSync(join(FIX, 'pdf/TCB_10_inday.pdf')));
    const { bulletin: parsed } = await parseBulletinPdf(pdf);
    const raw = {
      sourceUrl: 'https://example.test/tcb10.pdf',
      sourceHash: sha256(Buffer.from(pdf)),
      parserVersion: PARSER_VERSION,
    };

    const first = await persistBulletin(prisma, parsed, raw);
    expect(first.outcome).toBe('created');
    expect(first.events.map((e) => e.type)).toContain('bulletin.issued');

    const counts = async () => ({
      cyclones: await prisma.cyclone.count(),
      bulletins: await prisma.bulletin.count(),
      signals: await prisma.windSignal.count(),
    });
    const afterFirst = await counts();
    expect(afterFirst.bulletins).toBe(1);
    expect(afterFirst.signals).toBeGreaterThan(20);

    const second = await persistBulletin(prisma, parsed, raw);
    expect(second.outcome).toBe('unchanged');
    expect(second.events).toEqual([]);
    expect(await counts()).toEqual(afterFirst);
  });

  it('detects signal changes across consecutive bulletins of one cyclone', async () => {
    const b1pdf = new Uint8Array(readFileSync(join(FIX, 'pdf/TCB_1_inday.pdf')));
    const b10pdf = new Uint8Array(readFileSync(join(FIX, 'pdf/TCB_10_inday.pdf')));
    const { bulletin: b1 } = await parseBulletinPdf(b1pdf);
    const { bulletin: b10 } = await parseBulletinPdf(b10pdf);

    await persistBulletin(prisma, b1, {
      sourceUrl: 'u1',
      sourceHash: sha256(Buffer.from(b1pdf)),
      parserVersion: PARSER_VERSION,
    });
    const second = await persistBulletin(prisma, b10, {
      sourceUrl: 'u10',
      sourceHash: sha256(Buffer.from(b10pdf)),
      parserVersion: PARSER_VERSION,
    });

    expect(await prisma.cyclone.count()).toBe(1);
    const types = second.events.map((e) => e.type);
    expect(types).toContain('signal.raised'); // Batanes went 0 -> 2 between TCB#1 and #10
    const batanes = second.events.find(
      (e) => e.type === 'signal.raised' && e.signal?.psgcCode === '020900000',
    );
    expect(batanes?.signal).toMatchObject({ previousLevel: null, newLevel: 2 });
  });

  it('marks the cyclone EXITED on a final outside-PAR bulletin', async () => {
    const pdf16 = new Uint8Array(readFileSync(join(FIX, 'pdf/TCB_16_inday.pdf')));
    const { bulletin: b16 } = await parseBulletinPdf(pdf16);
    const result = await persistBulletin(prisma, b16, {
      sourceUrl: 'u16',
      sourceHash: sha256(Buffer.from(pdf16)),
      parserVersion: PARSER_VERSION,
    });
    expect(result.cyclone.status).toBe('EXITED');
    expect(result.events.map((e) => e.type)).toContain('cyclone.exited_par');
  });
});

describe('webhook retry schedule', () => {
  it('follows 1m, 5m, 30m, 2h, 12h', () => {
    expect(WEBHOOK_RETRY_DELAYS_MS).toEqual([60000, 300000, 1800000, 7200000, 43200000]);
    expect(retryDelayFor(1)).toBe(60000);
    expect(retryDelayFor(2)).toBe(300000);
    expect(retryDelayFor(5)).toBe(43200000);
    expect(retryDelayFor(99)).toBe(43200000);
  });
});

function sampleEvent(): DomainEvent {
  return {
    type: 'signal.raised',
    occurredAt: '2026-07-10T05:00:00+08:00',
    cyclone: { id: 'c1', pagasaName: 'INDAY', internationalName: 'BAVI', category: 'TY' },
    bulletin: { id: 'b1', bulletinNumber: 10, issuedAt: '2026-07-10T05:00:00+08:00' },
    signal: { psgcCode: '020900000', locationName: 'Batanes', previousLevel: 1, newLevel: 2 },
  };
}

async function makeSubscription(targetUrl: string, over: Record<string, unknown> = {}) {
  const user = await prisma.user.create({
    data: { email: `w${Date.now()}-${Math.random()}@t.local`, passwordHash: 'x' },
  });
  return prisma.webhookSubscription.create({
    data: {
      userId: user.id,
      targetUrl,
      secret: 'whsec_integration_test',
      eventTypes: ['signal.raised', 'signal.lowered'],
      psgcFilter: [],
      minSignalLevel: 1,
      ...over,
    },
  });
}

function receiver(handler: (status: number) => number): Promise<{
  server: Server;
  url: string;
  requests: { body: string; headers: Record<string, string | string[] | undefined> }[];
}> {
  const requests: { body: string; headers: Record<string, string | string[] | undefined> }[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        requests.push({ body, headers: req.headers });
        res.statusCode = handler(200);
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/hook`, requests });
    });
  });
}

describe('webhook dispatch (fanout worker + delivery worker + real receiver)', () => {
  it('delivers a signed payload that verifies, and records SUCCESS', async () => {
    const { server, url, requests } = await receiver(() => 200);
    const sub = await makeSubscription(url);

    workers.push(
      createEventFanoutWorker({ prisma, logger, webhooksQueue, connection: conn() }),
      createWebhookWorker({ prisma, logger, webhooksQueue, connection: conn() }),
    );

    await eventsQueue.add('signal.raised', sampleEvent());
    await waitFor(() => Promise.resolve(requests.length > 0));
    await waitFor(async () =>
      prisma.webhookDelivery
        .findFirst({ where: { subscriptionId: sub.id, status: 'SUCCESS' } })
        .then(Boolean),
    );

    const req = requests[0]!;
    const signature = String(req.headers['x-bagyo-signature']);
    const timestamp = String(req.headers['x-bagyo-timestamp']);
    expect(req.headers['x-bagyo-event']).toBe('signal.raised');
    expect(verifyWebhookSignature('whsec_integration_test', timestamp, req.body, signature)).toBe(
      true,
    );
    const payload = JSON.parse(req.body) as { event: DomainEvent };
    expect(payload.event.signal?.locationName).toBe('Batanes');

    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      where: { subscriptionId: sub.id },
    });
    expect(delivery.status).toBe('SUCCESS');
    expect(delivery.deliveredAt).not.toBeNull();
    server.close();
  });

  it('respects filters: no delivery for a below-threshold signal', async () => {
    const { server, url } = await receiver(() => 200);
    await makeSubscription(url, { minSignalLevel: 4 });
    workers.push(createEventFanoutWorker({ prisma, logger, webhooksQueue, connection: conn() }));

    await eventsQueue.add('signal.raised', sampleEvent());
    await waitFor(async () => (await eventsQueue.getWaitingCount()) === 0);
    await new Promise((r) => setTimeout(r, 500));
    expect(await prisma.webhookDelivery.count()).toBe(0);
    server.close();
  });

  it('marks FAILED on receiver errors and auto-disables at 20 consecutive failures', async () => {
    const { server, url } = await receiver(() => 500);
    const sub = await makeSubscription(url, { failureCount: 19 });
    workers.push(createWebhookWorker({ prisma, logger, webhooksQueue, connection: conn() }));

    const delivery = await prisma.webhookDelivery.create({
      data: { subscriptionId: sub.id, eventType: 'signal.raised', payload: sampleEvent() },
    });
    // Single attempt so the failure is terminal without waiting out the backoff ladder.
    await webhooksQueue.add('deliver', { deliveryId: delivery.id }, { attempts: 1 });

    await waitFor(async () =>
      prisma.webhookDelivery
        .findUnique({ where: { id: delivery.id } })
        .then((d) => d?.status === 'FAILED'),
    );
    await waitFor(async () =>
      prisma.webhookSubscription.findUnique({ where: { id: sub.id } }).then((s) => !s?.active),
    );
    const disabled = await prisma.webhookSubscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(disabled.failureCount).toBe(20);
    expect(disabled.disabledAt).not.toBeNull();
    server.close();
  });

  it('fanout enqueues deliveries with the full retry budget', async () => {
    const { server, url } = await receiver(() => 200);
    await makeSubscription(url);
    workers.push(createEventFanoutWorker({ prisma, logger, webhooksQueue, connection: conn() }));

    await eventsQueue.add('signal.raised', sampleEvent());
    await waitFor(async () => (await webhooksQueue.getJobs()).length > 0);
    const [job] = await webhooksQueue.getJobs();
    expect(job?.opts.attempts).toBe(WEBHOOK_RETRY_DELAYS_MS.length + 1);
    expect(job?.opts.backoff).toMatchObject({ type: 'custom' });
    server.close();
  });
});
