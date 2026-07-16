import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { API_KEY_LOOKUP_PREFIX_LENGTH, API_KEY_PREFIX_LIVE } from '@bagyo/shared';
import type { AppDeps } from '../types.js';
import { ApiError, notFound, unauthorized } from '../errors.js';
import { envelope, wrap, zApiKeyPublic, zErrorEnvelope, iso } from '../schemas.js';

export function generateApiKey(): { key: string; prefix: string; hashedKey: string } {
  const key = `${API_KEY_PREFIX_LIVE}${randomBytes(20).toString('hex')}`;
  return {
    key,
    prefix: key.slice(0, API_KEY_LOOKUP_PREFIX_LENGTH),
    hashedKey: createHash('sha256').update(key).digest('hex'),
  };
}

/**
 * Minimal account management so the API is self-serve:
 * register → get your first key (shown once) → manage keys.
 */
export function registerAccountRoutes(fastify: FastifyInstance, deps: AppDeps): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { prisma } = deps;

  app.post(
    '/v1/account/register',
    {
      config: { rateLimitExempt: true },
      schema: {
        tags: ['account'],
        summary: 'Create an account and receive your first API key (shown once)',
        body: z
          .object({
            email: z.email(),
            password: z.string().min(10).max(200),
          })
          .strict(),
        response: {
          201: envelope(
            z.object({
              userId: z.string(),
              apiKey: z.string(),
              tier: z.string(),
              note: z.string(),
            }),
          ),
          409: zErrorEnvelope,
          422: zErrorEnvelope,
        },
      },
    },
    async (req, reply) => {
      const existing = await prisma.user.findUnique({ where: { email: req.body.email } });
      if (existing) {
        throw new ApiError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
      }
      const passwordHash = await argon2.hash(req.body.password, { type: argon2.argon2id });
      const { key, prefix, hashedKey } = generateApiKey();
      const user = await prisma.user.create({
        data: {
          email: req.body.email,
          passwordHash,
          apiKeys: { create: { prefix, hashedKey, tier: 'FREE', name: 'default' } },
        },
      });
      return reply.status(201).send(
        wrap({
          userId: user.id,
          apiKey: key,
          tier: 'FREE',
          note: 'Store this key now — it is shown only once and only its hash is kept.',
        }),
      );
    },
  );

  app.get(
    '/v1/keys',
    {
      schema: {
        tags: ['account'],
        summary: 'List your API keys (prefixes only)',
        response: {
          200: envelope(z.object({ keys: z.array(zApiKeyPublic) })),
          401: zErrorEnvelope,
        },
      },
    },
    async (req) => {
      if (!req.auth) throw unauthorized();
      const keys = await prisma.apiKey.findMany({
        where: { userId: req.auth.userId },
        orderBy: { createdAt: 'desc' },
      });
      return wrap({
        keys: keys.map((k) => ({
          id: k.id,
          prefix: k.prefix,
          tier: k.tier,
          name: k.name,
          createdAt: iso(k.createdAt),
          revokedAt: k.revokedAt ? iso(k.revokedAt) : null,
          lastUsedAt: k.lastUsedAt ? iso(k.lastUsedAt) : null,
        })),
      });
    },
  );

  app.post(
    '/v1/keys',
    {
      schema: {
        tags: ['account'],
        summary: 'Create an additional API key (shown once)',
        body: z.object({ name: z.string().min(1).max(60).optional() }).strict(),
        response: {
          201: envelope(z.object({ id: z.string(), apiKey: z.string(), note: z.string() })),
          401: zErrorEnvelope,
          422: zErrorEnvelope,
        },
      },
    },
    async (req, reply) => {
      if (!req.auth) throw unauthorized();
      const count = await prisma.apiKey.count({
        where: { userId: req.auth.userId, revokedAt: null },
      });
      if (count >= 10) {
        throw new ApiError(422, 'LIMIT_REACHED', 'Maximum 10 active API keys per account');
      }
      const { key, prefix, hashedKey } = generateApiKey();
      const created = await prisma.apiKey.create({
        data: {
          userId: req.auth.userId,
          prefix,
          hashedKey,
          tier: req.auth.tier,
          name: req.body.name ?? null,
        },
      });
      return reply.status(201).send(
        wrap({
          id: created.id,
          apiKey: key,
          note: 'Store this key now — it is shown only once and only its hash is kept.',
        }),
      );
    },
  );

  app.delete(
    '/v1/keys/:id',
    {
      schema: {
        tags: ['account'],
        summary: 'Revoke an API key',
        params: z.object({ id: z.string() }).strict(),
        response: {
          200: envelope(z.object({ revoked: z.boolean() })),
          401: zErrorEnvelope,
          404: zErrorEnvelope,
        },
      },
    },
    async (req) => {
      if (!req.auth) throw unauthorized();
      const key = await prisma.apiKey.findFirst({
        where: { id: req.params.id, userId: req.auth.userId },
      });
      if (!key) throw notFound('API key');
      await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
      return wrap({ revoked: true });
    },
  );
}
