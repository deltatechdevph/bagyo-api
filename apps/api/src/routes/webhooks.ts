import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { WEBHOOK_EVENT_TYPES } from '@bagyo/shared';
import { WEBHOOK_RETRY_DELAYS_MS, zWebhookEventType } from '@bagyo/shared';
import type { AppDeps } from '../types.js';
import { ApiError, notFound, unauthorized } from '../errors.js';
import { envelope, wrap, zErrorEnvelope, zWebhookSubscription, iso } from '../schemas.js';
import type { WebhookSubscription } from '@bagyo/db';

function serializeSubscription(s: WebhookSubscription) {
  return {
    id: s.id,
    targetUrl: s.targetUrl,
    eventTypes: s.eventTypes as (typeof WEBHOOK_EVENT_TYPES)[number][],
    psgcFilter: s.psgcFilter,
    minSignalLevel: s.minSignalLevel,
    active: s.active,
    failureCount: s.failureCount,
    createdAt: iso(s.createdAt),
  };
}

export function registerWebhookRoutes(fastify: FastifyInstance, deps: AppDeps): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { prisma } = deps;

  const requireAuth = (req: { auth?: { userId: string } }) => {
    if (!req.auth) throw unauthorized();
    return req.auth;
  };

  app.get(
    '/v1/webhooks',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'List your webhook subscriptions',
        response: {
          200: envelope(z.object({ webhooks: z.array(zWebhookSubscription) })),
          401: zErrorEnvelope,
        },
      },
    },
    async (req) => {
      const { userId } = requireAuth(req);
      const subs = await prisma.webhookSubscription.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
      return wrap({ webhooks: subs.map(serializeSubscription) });
    },
  );

  app.post(
    '/v1/webhooks',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Create a webhook subscription',
        description:
          'The signing `secret` is returned ONCE in this response. Deliveries are signed ' +
          '`X-Bagyo-Signature: sha256=HMAC_SHA256(secret, "<X-Bagyo-Timestamp>.<body>")`. ' +
          `Retries: ${WEBHOOK_RETRY_DELAYS_MS.map((ms) => `${ms / 60000}m`).join(', ')}, then failed.`,
        body: z
          .object({
            targetUrl: z.url({ protocol: /^https?$/ }),
            eventTypes: z.array(zWebhookEventType).min(1),
            psgcFilter: z
              .array(z.string().regex(/^\d{9}$/))
              .max(200)
              .default([]),
            minSignalLevel: z.number().int().min(1).max(5).default(1),
          })
          .strict(),
        response: {
          201: envelope(zWebhookSubscription.extend({ secret: z.string() })),
          401: zErrorEnvelope,
          422: zErrorEnvelope,
        },
      },
    },
    async (req, reply) => {
      const { userId } = requireAuth(req);
      const count = await prisma.webhookSubscription.count({ where: { userId } });
      if (count >= 25) {
        throw new ApiError(422, 'LIMIT_REACHED', 'Maximum 25 webhook subscriptions per account');
      }
      const secret = `whsec_${randomBytes(24).toString('hex')}`;
      const sub = await prisma.webhookSubscription.create({
        data: {
          userId,
          targetUrl: req.body.targetUrl,
          secret,
          eventTypes: req.body.eventTypes,
          psgcFilter: req.body.psgcFilter,
          minSignalLevel: req.body.minSignalLevel,
        },
      });
      return reply.status(201).send(wrap({ ...serializeSubscription(sub), secret }));
    },
  );

  app.delete(
    '/v1/webhooks/:id',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Delete a webhook subscription',
        params: z.object({ id: z.string() }).strict(),
        response: {
          200: envelope(z.object({ deleted: z.boolean() })),
          401: zErrorEnvelope,
          404: zErrorEnvelope,
        },
      },
    },
    async (req) => {
      const { userId } = requireAuth(req);
      const sub = await prisma.webhookSubscription.findFirst({
        where: { id: req.params.id, userId },
      });
      if (!sub) throw notFound('Webhook subscription');
      await prisma.webhookSubscription.delete({ where: { id: sub.id } });
      return wrap({ deleted: true });
    },
  );

  app.post(
    '/v1/webhooks/:id/test',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Send a signed sample payload to the subscription target',
        params: z.object({ id: z.string() }).strict(),
        response: {
          202: envelope(z.object({ queued: z.boolean(), deliveryId: z.string() })),
          401: zErrorEnvelope,
          404: zErrorEnvelope,
        },
      },
    },
    async (req, reply) => {
      const { userId } = requireAuth(req);
      const sub = await prisma.webhookSubscription.findFirst({
        where: { id: req.params.id, userId },
      });
      if (!sub) throw notFound('Webhook subscription');

      const sample = {
        type: 'signal.raised',
        occurredAt: new Date().toISOString(),
        test: true,
        cyclone: { id: 'test', pagasaName: 'SAMPLE', internationalName: 'TEST', category: 'TY' },
        bulletin: { id: 'test', bulletinNumber: 1, issuedAt: new Date().toISOString() },
        signal: {
          psgcCode: sub.psgcFilter[0] ?? '031400000',
          locationName: 'Bulacan',
          previousLevel: 1,
          newLevel: Math.max(2, sub.minSignalLevel),
        },
      };
      const delivery = await prisma.webhookDelivery.create({
        data: { subscriptionId: sub.id, eventType: 'signal.raised', payload: sample },
      });
      await deps.webhooksQueue.add(
        'deliver',
        { deliveryId: delivery.id },
        { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
      );
      return reply.status(202).send(wrap({ queued: true, deliveryId: delivery.id }));
    },
  );
}
