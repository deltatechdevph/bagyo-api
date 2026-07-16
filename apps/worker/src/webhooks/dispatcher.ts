import { request } from 'undici';
import { Worker, type ConnectionOptions, type Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { PrismaClient, WebhookSubscription } from '@bagyo/db';
import {
  QUEUE_NAMES,
  signWebhookPayload,
  WEBHOOK_MAX_CONSECUTIVE_FAILURES,
  WEBHOOK_RETRY_DELAYS_MS,
  zDomainEvent,
  type DomainEvent,
} from '@bagyo/shared';

export interface DispatcherDeps {
  prisma: PrismaClient;
  logger: Logger;
  webhooksQueue: Queue;
  connection: ConnectionOptions;
}

/**
 * Does this subscription want this event?
 *  - eventTypes must include the type
 *  - a non-empty psgcFilter restricts the subscription to signal events touching
 *    those areas (other event types are considered area-less and are skipped)
 *  - minSignalLevel gates signal events by max(previous, new) level
 */
export function subscriptionMatches(
  sub: Pick<WebhookSubscription, 'eventTypes' | 'psgcFilter' | 'minSignalLevel'>,
  event: DomainEvent,
): boolean {
  if (!sub.eventTypes.includes(event.type)) return false;
  const isSignalEvent = event.type === 'signal.raised' || event.type === 'signal.lowered';
  if (sub.psgcFilter.length > 0) {
    if (!isSignalEvent || !event.signal) return false;
    if (!event.signal.psgcCode || !sub.psgcFilter.includes(event.signal.psgcCode)) return false;
  }
  if (isSignalEvent && event.signal) {
    const level = Math.max(event.signal.previousLevel ?? 0, event.signal.newLevel ?? 0);
    if (level < sub.minSignalLevel) return false;
  }
  return true;
}

/** Retry delay for a delivery attempt (1-indexed attemptsMade): 1m, 5m, 30m, 2h, 12h. */
export function retryDelayFor(attemptsMade: number): number {
  return (
    WEBHOOK_RETRY_DELAYS_MS[
      Math.min(Math.max(attemptsMade - 1, 0), WEBHOOK_RETRY_DELAYS_MS.length - 1)
    ] ?? 60_000
  );
}

/** Consumes domain events and fans them out into per-subscription deliveries. */
export function createEventFanoutWorker(deps: DispatcherDeps): Worker {
  const { prisma, logger } = deps;
  const worker = new Worker(
    QUEUE_NAMES.events,
    async (job) => {
      const parsed = zDomainEvent.safeParse(job.data);
      if (!parsed.success) {
        logger.error({ issues: parsed.error.issues }, 'invalid domain event — dropped');
        return { dropped: true };
      }
      const event = parsed.data;
      const subscriptions = await prisma.webhookSubscription.findMany({
        where: { active: true },
      });
      let queued = 0;
      for (const sub of subscriptions) {
        if (!subscriptionMatches(sub, event)) continue;
        const delivery = await prisma.webhookDelivery.create({
          data: { subscriptionId: sub.id, eventType: event.type, payload: event },
        });
        await deps.webhooksQueue.add(
          'deliver',
          { deliveryId: delivery.id },
          {
            attempts: WEBHOOK_RETRY_DELAYS_MS.length + 1,
            backoff: { type: 'custom' },
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        );
        queued += 1;
      }
      return { queued };
    },
    { connection: deps.connection, concurrency: 4 },
  );
  worker.on('failed', (job, err) =>
    logger.error({ job: job?.id, err: err.message }, 'event fanout failed'),
  );
  return worker;
}

/** Delivers webhooks with HMAC signatures and scheduled retries. */
export function createWebhookWorker(deps: DispatcherDeps): Worker {
  const { prisma, logger } = deps;
  const worker = new Worker(
    QUEUE_NAMES.webhooks,
    async (job) => {
      const { deliveryId } = job.data as { deliveryId: string };
      const delivery = await prisma.webhookDelivery.findUnique({
        where: { id: deliveryId },
        include: { subscription: true },
      });
      if (!delivery) return { missing: true };
      if (!delivery.subscription.active) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'EXHAUSTED', lastError: 'subscription disabled' },
        });
        return { skipped: 'inactive' };
      }

      const timestamp = String(Date.now());
      const body = JSON.stringify({
        id: delivery.id,
        attempt: job.attemptsMade + 1,
        sentAt: new Date().toISOString(),
        event: delivery.payload,
      });
      const signature = signWebhookPayload(delivery.subscription.secret, timestamp, body);

      try {
        const res = await request(delivery.subscription.targetUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'BagyoAPI-Webhooks/1.0',
            'x-bagyo-signature': signature,
            'x-bagyo-timestamp': timestamp,
            'x-bagyo-delivery': delivery.id,
            'x-bagyo-event': delivery.eventType,
          },
          body,
          headersTimeout: 10_000,
          bodyTimeout: 10_000,
        });
        await res.body.dump();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          throw new Error(`receiver responded ${res.statusCode}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const attempts = job.attemptsMade + 1;
        const maxAttempts = job.opts.attempts ?? WEBHOOK_RETRY_DELAYS_MS.length + 1;
        const isLast = attempts >= maxAttempts;
        const nextDelay =
          WEBHOOK_RETRY_DELAYS_MS[Math.min(job.attemptsMade, WEBHOOK_RETRY_DELAYS_MS.length - 1)];
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: isLast ? 'FAILED' : 'PENDING',
            attempts,
            lastError: message.slice(0, 500),
            nextRetryAt: isLast ? null : new Date(Date.now() + (nextDelay ?? 60_000)),
          },
        });
        if (isLast) {
          // Count one consecutive failure per exhausted delivery; auto-disable at the cap.
          const sub = await prisma.webhookSubscription.update({
            where: { id: delivery.subscriptionId },
            data: { failureCount: { increment: 1 } },
          });
          if (sub.failureCount >= WEBHOOK_MAX_CONSECUTIVE_FAILURES && sub.active) {
            await prisma.webhookSubscription.update({
              where: { id: sub.id },
              data: { active: false, disabledAt: new Date() },
            });
            logger.warn(
              { subscriptionId: sub.id, failureCount: sub.failureCount },
              'webhook subscription auto-disabled after consecutive failures',
            );
          }
        }
        throw err instanceof Error ? err : new Error(message);
      }

      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'SUCCESS',
          attempts: job.attemptsMade + 1,
          deliveredAt: new Date(),
          nextRetryAt: null,
          lastError: null,
        },
      });
      await prisma.webhookSubscription.update({
        where: { id: delivery.subscriptionId },
        data: { failureCount: 0 },
      });
      return { delivered: true };
    },
    {
      connection: deps.connection,
      concurrency: 8,
      settings: {
        backoffStrategy: (attemptsMade: number) => retryDelayFor(attemptsMade),
      },
    },
  );
  worker.on('failed', (job, err) => {
    logger.warn({ job: job?.id, err: err.message }, 'webhook delivery attempt failed');
  });
  return worker;
}
