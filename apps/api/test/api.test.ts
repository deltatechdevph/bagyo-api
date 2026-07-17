/**
 * API integration tests — require Postgres (migrated) and Redis:
 *   docker compose up -d postgres redis && pnpm db:migrate
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaClient } from '@bagyo/db';
import type { FastifyInstance } from 'fastify';
import { parseEnv, QUEUE_NAMES, ATTRIBUTION, DISCLAIMER, CACHE_PREFIX } from '@bagyo/shared';
import { parseBulletinPdf, PARSER_VERSION } from '@bagyo/parser';
import { buildApp } from '../src/app.js';
import { persistBulletin, sha256 } from '@bagyo/ingest';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://bagyo:bagyo@localhost:5432/bagyo?schema=public';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const FIX = join(import.meta.dirname, '../../../fixtures');

let prisma: PrismaClient;
let redis: Redis;
let webhooksQueue: Queue;
let app: FastifyInstance;
let request: TestAgent;

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

async function registerUser(email = `u${Date.now()}@t.local`): Promise<string> {
  const res = await request
    .post('/v1/account/register')
    .send({ email, password: 'super-secret-password' })
    .expect(201);
  return (res.body as { data: { apiKey: string } }).data.apiKey;
}

async function ingestFixture(name = 'TCB_10_inday.pdf') {
  const pdf = new Uint8Array(readFileSync(join(FIX, 'pdf', name)));
  const { bulletin } = await parseBulletinPdf(pdf);
  return persistBulletin(prisma, bulletin, {
    sourceUrl: `https://example.test/${name}`,
    sourceHash: sha256(Buffer.from(pdf)),
    parserVersion: PARSER_VERSION,
  });
}

describe('auth & open access', () => {
  it('data endpoints are open — anonymous GET succeeds with per-IP rate headers', async () => {
    const res = await request.get('/v1/cyclones').expect(200);
    expect(res.headers['x-ratelimit-limit']).toBe('10000'); // ANON_DAILY_LIMIT
    expect((res.body as { source: string }).source).toBe('DOST-PAGASA');
  });

  it('stateful endpoints still require a key, with the error envelope', async () => {
    const res = await request.get('/v1/webhooks').expect(401);
    const unauthorizedBody = res.body as { error: { code: string; message: string } };
    expect(unauthorizedBody.error.code).toBe('UNAUTHORIZED');
    expect(unauthorizedBody.error.message).toContain('API key');
    expect((res.body as { error: { docs: string } }).error.docs).toContain('http');
  });

  it('401 for a presented-but-unknown key, even on open data routes', async () => {
    await request
      .get('/v1/cyclones')
      .set('authorization', `Bearer bgy_live_${'0'.repeat(40)}`)
      .expect(401);
  });

  it('401 for a revoked key', async () => {
    const key = await registerUser();
    const prefix = key.slice(0, 17);
    await prisma.apiKey.update({ where: { prefix }, data: { revokedAt: new Date() } });
    await request.get('/v1/cyclones').set('authorization', `Bearer ${key}`).expect(401);
  });

  it('health and docs are public', async () => {
    await request.get('/v1/health').expect(200);
    await request.get('/docs').expect((r) => expect([200, 302]).toContain(r.status));
  });
});

describe('account & keys', () => {
  it('register returns a PRO-visible key exactly once and never stores plaintext', async () => {
    const key = await registerUser('once@t.local');
    expect(key).toMatch(/^bgy_live_[0-9a-f]{40}$/);
    const rows = await prisma.apiKey.findMany();
    expect(rows[0]?.hashedKey).toHaveLength(64);
    expect(JSON.stringify(rows)).not.toContain(key.slice(17));
  });

  it('409 for duplicate email', async () => {
    await registerUser('dup@t.local');
    const res = await request
      .post('/v1/account/register')
      .send({ email: 'dup@t.local', password: 'super-secret-password' })
      .expect(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('EMAIL_TAKEN');
  });

  it('422 for a weak password (Zod strict validation)', async () => {
    const res = await request
      .post('/v1/account/register')
      .send({ email: 'weak@t.local', password: 'short' })
      .expect(422);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects unknown body keys', async () => {
    await request
      .post('/v1/account/register')
      .send({ email: 'x@t.local', password: 'super-secret-password', admin: true })
      .expect(422);
  });

  it('key lifecycle: create, list, revoke', async () => {
    const key = await registerUser();
    const created = await request
      .post('/v1/keys')
      .set('authorization', `Bearer ${key}`)
      .send({ name: 'ci' })
      .expect(201);
    const newKey = (created.body as { data: { apiKey: string; id: string } }).data;

    const list = await request.get('/v1/keys').set('authorization', `Bearer ${key}`).expect(200);
    expect((list.body as { data: { keys: unknown[] } }).data.keys).toHaveLength(2);

    await request.delete(`/v1/keys/${newKey.id}`).set('authorization', `Bearer ${key}`).expect(200);
    await request.get('/v1/keys').set('authorization', `Bearer ${newKey.apiKey}`).expect(401);
  });
});

describe('cyclone & bulletin endpoints (fixture-backed)', () => {
  it('serves ingested INDAY data with attribution and disclaimer on every response', async () => {
    await ingestFixture();
    const key = await registerUser();
    const auth = { authorization: `Bearer ${key}` };

    const list = await request.get('/v1/cyclones').set(auth).expect(200);
    const body = list.body as {
      data: { cyclones: { pagasaName: string; id: string }[] };
      source: string;
      disclaimer: string;
    };
    expect(body.source).toBe(ATTRIBUTION);
    expect(body.disclaimer).toBe(DISCLAIMER);
    expect(body.data.cyclones[0]).toMatchObject({
      pagasaName: 'INDAY',
      internationalName: 'BAVI',
      category: 'TY',
      status: 'ACTIVE',
      seasonYear: 2026,
    });

    const active = await request.get('/v1/cyclones/active').set(auth).expect(200);
    const activeBody = active.body as {
      data: { cyclones: { latestBulletin: { bulletinNumber: number; windSignals: unknown[] } }[] };
    };
    expect(activeBody.data.cyclones[0]?.latestBulletin.bulletinNumber).toBe(10);
    expect(activeBody.data.cyclones[0]?.latestBulletin.windSignals.length).toBeGreaterThan(20);

    const id = body.data.cyclones[0]!.id;
    const single = await request.get(`/v1/cyclones/${id}`).set(auth).expect(200);
    expect((single.body as { data: { bulletinCount: number } }).data.bulletinCount).toBe(1);

    const bulletins = await request.get(`/v1/cyclones/${id}/bulletins`).set(auth).expect(200);
    const bl = bulletins.body as {
      data: { bulletins: { issuedAt: string; maxWindsKph: number }[] };
    };
    expect(bl.data.bulletins[0]).toMatchObject({ maxWindsKph: 150 });

    const latest = await request.get('/v1/bulletins/latest').set(auth).expect(200);
    expect(
      (latest.body as { data: { bulletin: { bulletinNumber: number } } }).data.bulletin
        .bulletinNumber,
    ).toBe(10);
  });

  it('404 envelope for a missing cyclone', async () => {
    const key = await registerUser();
    const res = await request
      .get('/v1/cyclones/nonexistent-id')
      .set('authorization', `Bearer ${key}`)
      .expect(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('paginates bulletins with a cursor', async () => {
    await ingestFixture('TCB_1_inday.pdf');
    await ingestFixture('TCB_10_inday.pdf');
    const key = await registerUser();
    const auth = { authorization: `Bearer ${key}` };
    const cyclones = await request.get('/v1/cyclones').set(auth).expect(200);
    const id = (cyclones.body as { data: { cyclones: { id: string }[] } }).data.cyclones[0]!.id;

    const page1 = await request.get(`/v1/cyclones/${id}/bulletins?limit=1`).set(auth).expect(200);
    const p1 = page1.body as {
      data: { bulletins: { bulletinNumber: number }[]; pagination: { nextCursor: string } };
    };
    expect(p1.data.bulletins[0]?.bulletinNumber).toBe(10); // newest first
    expect(p1.data.pagination.nextCursor).toBeTruthy();

    const page2 = await request
      .get(`/v1/cyclones/${id}/bulletins?limit=1&cursor=${p1.data.pagination.nextCursor}`)
      .set(auth)
      .expect(200);
    const p2 = page2.body as { data: { bulletins: { bulletinNumber: number }[] } };
    expect(p2.data.bulletins[0]?.bulletinNumber).toBe(1);
  });
});

describe('signals endpoints', () => {
  it('groups current signals by level', async () => {
    await ingestFixture();
    const key = await registerUser();
    const res = await request
      .get('/v1/signals/current')
      .set('authorization', `Bearer ${key}`)
      .expect(200);
    const body = res.body as {
      data: { inEffect: boolean; byLevel: Record<string, { locationName: string }[]> };
    };
    expect(body.data.inEffect).toBe(true);
    expect(Object.keys(body.data.byLevel).sort()).toEqual(['1', '2']);
    expect(body.data.byLevel['2']?.map((a) => a.locationName)).toContain('Batanes');
  });

  it('lookup by PSGC: direct hit, parent-province inheritance, and none', async () => {
    await ingestFixture();
    const key = await registerUser();
    const auth = { authorization: `Bearer ${key}` };

    const direct = await request.get('/v1/signals/lookup?psgc=020900000').set(auth).expect(200);
    expect(
      (direct.body as { data: { signal: { level: number; coverage: string } } }).data.signal,
    ).toMatchObject({ level: 2, coverage: 'direct' });

    // Santa Ana, Cagayan is directly listed under Signal 2.
    const mun = await request.get('/v1/signals/lookup?psgc=021523000').set(auth).expect(200);
    expect((mun.body as { data: { signal: { level: number } } }).data.signal.level).toBe(2);

    // Tuao, Cagayan is not listed itself, but Cagayan province rows cover it.
    const inherited = await request.get('/v1/signals/lookup?psgc=021528000').set(auth).expect(200);
    const inh = (
      inherited.body as {
        data: { signal: { coverage: string; partialDescriptor: string | null } | null };
      }
    ).data.signal;
    expect(inh?.coverage).toBe('parent-province');

    // Davao Oriental is far away — no signal.
    const none = await request.get('/v1/signals/lookup?psgc=112500000').set(auth).expect(200);
    expect((none.body as { data: { signal: null } }).data.signal).toBeNull();
  });

  it('lookup by free-text name', async () => {
    await ingestFixture();
    const key = await registerUser();
    const res = await request
      .get('/v1/signals/lookup?q=batanes')
      .set('authorization', `Bearer ${key}`)
      .expect(200);
    const data = (
      res.body as {
        data: { query: { psgcCode: string }; signal: { level: number } };
      }
    ).data;
    expect(data.query.psgcCode).toBe('020900000');
    expect(data.signal.level).toBe(2);
  });

  it('422 for ambiguous or missing query params', async () => {
    const key = await registerUser();
    const auth = { authorization: `Bearer ${key}` };
    await request.get('/v1/signals/lookup').set(auth).expect(422);
    await request.get('/v1/signals/lookup?psgc=020900000&q=batanes').set(auth).expect(422);
    await request.get('/v1/signals/lookup?psgc=12345').set(auth).expect(422);
  });

  it('serves lookups from cache and repopulates after invalidation', async () => {
    await ingestFixture();
    const key = await registerUser();
    const auth = { authorization: `Bearer ${key}` };
    await request.get('/v1/signals/lookup?psgc=020900000').set(auth).expect(200);
    const cacheKeys = await redis.keys(`${CACHE_PREFIX}*`);
    expect(cacheKeys.some((k) => k.includes('signals:lookup'))).toBe(true);
  });
});

describe('rate limiting', () => {
  it('emits X-RateLimit headers and 429 with Retry-After at quota', async () => {
    const key = await registerUser();
    const prefix = key.slice(0, 17);
    const first = await request
      .get('/v1/cyclones')
      .set('authorization', `Bearer ${key}`)
      .expect(200);
    expect(first.headers['x-ratelimit-limit']).toBe('100000'); // registered = PRO tier
    expect(Number(first.headers['x-ratelimit-remaining'])).toBeLessThan(100000);

    // Fill today's bucket to the quota.
    const { id: keyId } = await prisma.apiKey.findUniqueOrThrow({ where: { prefix } });
    const day = Math.floor(Date.now() / 86_400_000);
    await redis.set(`bagyo:rl:${keyId}:${day}`, '100000');

    const blocked = await request
      .get('/v1/cyclones')
      .set('authorization', `Bearer ${key}`)
      .expect(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect((blocked.body as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });

  it('anonymous readers share a per-IP quota', async () => {
    // trustProxy is on, so the limiter sees X-Forwarded-For — pin a test IP.
    const ip = '203.0.113.9';
    const day = Math.floor(Date.now() / 86_400_000);
    await redis.set(`bagyo:rl:ip:${ip}:${day}`, '10000');
    const blocked = await request.get('/v1/cyclones').set('x-forwarded-for', ip).expect(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });
});

describe('webhook management', () => {
  it('CRUD + secret shown once + test delivery queued', async () => {
    const key = await registerUser();
    const auth = { authorization: `Bearer ${key}` };

    const created = await request
      .post('/v1/webhooks')
      .set(auth)
      .send({
        targetUrl: 'https://example.com/hook',
        eventTypes: ['signal.raised'],
        psgcFilter: ['031400000'],
        minSignalLevel: 2,
      })
      .expect(201);
    const sub = (created.body as { data: { id: string; secret: string } }).data;
    expect(sub.secret).toMatch(/^whsec_/);

    const list = await request.get('/v1/webhooks').set(auth).expect(200);
    const listed = (list.body as { data: { webhooks: Record<string, unknown>[] } }).data
      .webhooks[0]!;
    expect(listed.secret).toBeUndefined(); // never shown again
    expect(listed).toMatchObject({ minSignalLevel: 2, active: true });

    const test = await request.post(`/v1/webhooks/${sub.id}/test`).set(auth).expect(202);
    expect((test.body as { data: { queued: boolean } }).data.queued).toBe(true);
    expect(await prisma.webhookDelivery.count({ where: { subscriptionId: sub.id } })).toBe(1);

    await request.delete(`/v1/webhooks/${sub.id}`).set(auth).expect(200);
    await request.post(`/v1/webhooks/${sub.id}/test`).set(auth).expect(404);
  });

  it('validates webhook payloads strictly', async () => {
    const key = await registerUser();
    await request
      .post('/v1/webhooks')
      .set('authorization', `Bearer ${key}`)
      .send({ targetUrl: 'not-a-url', eventTypes: ['signal.raised'] })
      .expect(422);
    await request
      .post('/v1/webhooks')
      .set('authorization', `Bearer ${key}`)
      .send({ targetUrl: 'https://x.com', eventTypes: ['nope'] })
      .expect(422);
  });
});

describe('operational endpoints', () => {
  it('/ready reports dependency status', async () => {
    const res = await request.get('/ready').expect(200);
    expect(res.body).toMatchObject({ postgres: true, redis: true });
  });

  it('/metrics exposes prometheus text', async () => {
    const res = await request.get('/metrics').expect(200);
    expect(res.text).toContain('bagyo_http_requests_total');
  });

  it('OpenAPI document matches served routes', async () => {
    const res = await request.get('/docs/json').expect(200);
    const doc = res.body as { paths: Record<string, unknown>; openapi: string };
    expect(doc.openapi).toBe('3.1.0');
    for (const p of [
      '/v1/cyclones',
      '/v1/cyclones/active',
      '/v1/cyclones/{id}',
      '/v1/cyclones/{id}/bulletins',
      '/v1/bulletins/latest',
      '/v1/signals/current',
      '/v1/signals/lookup',
      '/v1/rainfall/current',
      '/v1/webhooks',
      '/v1/webhooks/{id}/test',
      '/v1/health',
    ]) {
      expect(doc.paths[p], `missing ${p} in OpenAPI`).toBeDefined();
    }
  });

  it('unknown routes return the envelope', async () => {
    const key = await registerUser();
    const res = await request.get('/v1/nope').set('authorization', `Bearer ${key}`).expect(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});
