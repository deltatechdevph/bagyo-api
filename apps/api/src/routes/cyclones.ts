import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CACHE_KEYS, zCycloneStatus } from '@bagyo/shared';
import type { AppDeps } from '../types.js';
import { notFound } from '../errors.js';
import { cached } from '../cache.js';
import { serializeBulletinWithSignals, serializeCyclone } from '../serializers.js';
import {
  envelope,
  wrap,
  zActiveCyclone,
  zBulletinWithSignals,
  zCycloneSummary,
  zErrorEnvelope,
  zPagination,
} from '../schemas.js';

export function registerCycloneRoutes(fastify: FastifyInstance, deps: AppDeps): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { prisma, redis } = deps;

  app.get(
    '/v1/cyclones',
    {
      schema: {
        tags: ['cyclones'],
        summary: 'List cyclones',
        querystring: z
          .object({
            status: zCycloneStatus.optional(),
            year: z.coerce.number().int().min(1950).max(2100).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(20),
            cursor: z.string().optional(),
          })
          .strict(),
        response: {
          200: envelope(z.object({ cyclones: z.array(zCycloneSummary), pagination: zPagination })),
          401: zErrorEnvelope,
        },
      },
    },
    async (req) => {
      const { status, year, limit, cursor } = req.query;
      const rows = await prisma.cyclone.findMany({
        where: {
          ...(status ? { status } : {}),
          ...(year ? { seasonYear: year } : {}),
        },
        orderBy: [{ lastBulletinAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const page = rows.slice(0, limit);
      return wrap({
        cyclones: page.map(serializeCyclone),
        pagination: { nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null },
      });
    },
  );

  app.get(
    '/v1/cyclones/active',
    {
      schema: {
        tags: ['cyclones'],
        summary: 'Currently active cyclones with their latest bulletin embedded',
        response: {
          200: envelope(z.object({ cyclones: z.array(zActiveCyclone) })),
          401: zErrorEnvelope,
        },
      },
    },
    async () =>
      cached(redis, CACHE_KEYS.cyclonesActive, async () => {
        const active = await prisma.cyclone.findMany({
          where: { status: 'ACTIVE' },
          orderBy: { lastBulletinAt: 'desc' },
          include: {
            bulletins: {
              orderBy: { issuedAt: 'desc' },
              take: 1,
              include: { windSignals: true },
            },
          },
        });
        return wrap({
          cyclones: active.map((c) => ({
            ...serializeCyclone(c),
            latestBulletin: c.bulletins[0] ? serializeBulletinWithSignals(c.bulletins[0]) : null,
          })),
        });
      }),
  );

  app.get(
    '/v1/cyclones/:id',
    {
      schema: {
        tags: ['cyclones'],
        summary: 'Single cyclone with bulletin history summary',
        params: z.object({ id: z.string() }).strict(),
        response: {
          200: envelope(
            zCycloneSummary.extend({
              bulletinCount: z.number().int(),
              latestBulletin: zBulletinWithSignals.nullable(),
            }),
          ),
          401: zErrorEnvelope,
          404: zErrorEnvelope,
        },
      },
    },
    async (req) => {
      const cyclone = await prisma.cyclone.findUnique({
        where: { id: req.params.id },
        include: {
          _count: { select: { bulletins: true } },
          bulletins: { orderBy: { issuedAt: 'desc' }, take: 1, include: { windSignals: true } },
        },
      });
      if (!cyclone) throw notFound('Cyclone');
      return wrap({
        ...serializeCyclone(cyclone),
        bulletinCount: cyclone._count.bulletins,
        latestBulletin: cyclone.bulletins[0]
          ? serializeBulletinWithSignals(cyclone.bulletins[0])
          : null,
      });
    },
  );

  app.get(
    '/v1/cyclones/:id/bulletins',
    {
      schema: {
        tags: ['cyclones'],
        summary: 'Bulletin history, newest first (cursor pagination)',
        params: z.object({ id: z.string() }).strict(),
        querystring: z
          .object({
            limit: z.coerce.number().int().min(1).max(100).default(20),
            cursor: z.string().optional(),
          })
          .strict(),
        response: {
          200: envelope(
            z.object({ bulletins: z.array(zBulletinWithSignals), pagination: zPagination }),
          ),
          401: zErrorEnvelope,
          404: zErrorEnvelope,
        },
      },
    },
    async (req) => {
      const cyclone = await prisma.cyclone.findUnique({ where: { id: req.params.id } });
      if (!cyclone) throw notFound('Cyclone');
      const { limit, cursor } = req.query;
      const rows = await prisma.bulletin.findMany({
        where: { cycloneId: cyclone.id },
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
        include: { windSignals: true },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const page = rows.slice(0, limit);
      return wrap({
        bulletins: page.map(serializeBulletinWithSignals),
        pagination: { nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null },
      });
    },
  );

  app.get(
    '/v1/bulletins/latest',
    {
      schema: {
        tags: ['bulletins'],
        summary: 'Latest bulletin across all active cyclones',
        response: {
          200: envelope(
            z.object({
              bulletin: zBulletinWithSignals.nullable(),
              cyclone: zCycloneSummary.nullable(),
            }),
          ),
          401: zErrorEnvelope,
        },
      },
    },
    async () =>
      cached(redis, CACHE_KEYS.bulletinsLatest, async () => {
        const latest = await prisma.bulletin.findFirst({
          where: { cyclone: { status: 'ACTIVE' } },
          orderBy: { issuedAt: 'desc' },
          include: { windSignals: true, cyclone: true },
        });
        return wrap({
          bulletin: latest ? serializeBulletinWithSignals(latest) : null,
          cyclone: latest ? serializeCyclone(latest.cyclone) : null,
        });
      }),
  );
}
