/**
 * RapidAPI marketplace auth — requires Postgres (migrated) and Redis,
 * same as api.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaClient } from '@bagyo/db';
import type { FastifyInstance } from 'fastify';
import { parseEnv, QUEUE_NAMES } from '@bagyo/shared';
import { buildApp } from '../src/app.js';
import { rapidApiEmail, tierForRapidApiPlan } from '../src/plugins/rapidapi.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://bagyo:bagyo@localhost:5432/bagyo?schema=public';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const PROXY_SECRET = 'rapidapi-proxy-secret-for-tests-123';

let prisma: PrismaClient;
let redis: Redis;
let webhooksQueue: Queue;
let app: FastifyInstance;
let request: ReturnType<typeof supertest>;

beforeAll(async () => {
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.ping();
  webhooksQueue = new Queue(QUEUE_NAMES.webhooks, { connection: redis });
  const env = parseEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL,
    REDIS_URL,
    APP_SECRET: 'integration-test-secret-0123456789abcdef',
    RAPIDAPI_PROXY_SECRET: PROXY_SECRET,
  });
  app = await buildApp({ prisma, redis, webhooksQueue, env });
  await app.ready();
  request = supertest(app.server);
});

afterAll(async () => {
  await app?.close();
  await webhooksQueue?.close();
  redis?.disconnect();
  await prisma?.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "WebhookDelivery","WebhookSubscription","WindSignal","Bulletin","Cyclone","RainfallAdvisory","IngestRun","ApiKey","User" CASCADE',
  );
  const keys = await redis.keys('bagyo:*');
  if (keys.length) await redis.del(...keys);
});

describe('plan → tier mapping', () => {
  it('maps RapidAPI default plans and falls back to FREE', () => {
    expect(tierForRapidApiPlan('BASIC')).toBe('FREE');
    expect(tierForRapidApiPlan('pro')).toBe('HOBBY');
    expect(tierForRapidApiPlan('ULTRA')).toBe('PRO');
    expect(tierForRapidApiPlan('MEGA')).toBe('BUSINESS');
    expect(tierForRapidApiPlan('SOMETHING_ELSE')).toBe('FREE');
    expect(tierForRapidApiPlan(undefined)).toBe('FREE');
  });

  it('builds safe internal emails from marketplace usernames', () => {
    expect(rapidApiEmail('Juan_DelaCruz')).toBe('juan_delacruz@subscribers.rapidapi.local');
    expect(rapidApiEmail('weird // name!')).toBe('weird-name@subscribers.rapidapi.local');
  });
});

describe('RapidAPI proxy authentication', () => {
  it('accepts proxied requests and auto-provisions the subscriber', async () => {
    const res = await request
      .get('/v1/cyclones')
      .set('x-rapidapi-proxy-secret', PROXY_SECRET)
      .set('x-rapidapi-user', 'juan-dev')
      .set('x-rapidapi-subscription', 'ULTRA')
      .expect(200);
    expect(res.headers['x-ratelimit-limit']).toBe('100000'); // ULTRA -> PRO tier
    const user = await prisma.user.findUnique({
      where: { email: 'juan-dev@subscribers.rapidapi.local' },
    });
    expect(user).not.toBeNull();

    // Second request reuses the same provisioned user.
    await request
      .get('/v1/cyclones')
      .set('x-rapidapi-proxy-secret', PROXY_SECRET)
      .set('x-rapidapi-user', 'juan-dev')
      .expect(200);
    expect(await prisma.user.count()).toBe(1);
  });

  it('rejects a wrong proxy secret with 401', async () => {
    const res = await request
      .get('/v1/cyclones')
      .set('x-rapidapi-proxy-secret', 'wrong-secret-wrong-secret')
      .set('x-rapidapi-user', 'juan-dev')
      .expect(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('rejects proxied requests without a subscriber identity', async () => {
    await request.get('/v1/cyclones').set('x-rapidapi-proxy-secret', PROXY_SECRET).expect(401);
  });

  it('marketplace subscribers can manage webhooks like first-party users', async () => {
    const rapid = {
      'x-rapidapi-proxy-secret': PROXY_SECRET,
      'x-rapidapi-user': 'webhook-fan',
      'x-rapidapi-subscription': 'MEGA',
    };
    const created = await request
      .post('/v1/webhooks')
      .set(rapid)
      .send({ targetUrl: 'https://example.com/hook', eventTypes: ['signal.raised'] })
      .expect(201);
    const id = (created.body as { data: { id: string } }).data.id;
    const list = await request.get('/v1/webhooks').set(rapid).expect(200);
    expect((list.body as { data: { webhooks: { id: string }[] } }).data.webhooks[0]?.id).toBe(id);
  });

  it('bearer-key auth still works alongside marketplace auth', async () => {
    const reg = await request
      .post('/v1/account/register')
      .send({ email: 'direct@t.local', password: 'super-secret-password' })
      .expect(201);
    const key = (reg.body as { data: { apiKey: string } }).data.apiKey;
    await request.get('/v1/cyclones').set('authorization', `Bearer ${key}`).expect(200);
  });

  it('non-proxied requests are unaffected (no secret header → normal 401)', async () => {
    await request.get('/v1/cyclones').expect(401);
  });
});
