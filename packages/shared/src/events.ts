import { z } from 'zod';
import { zWebhookEventType, zSignalLevel } from './schemas.js';

/**
 * Domain events emitted by the ingestion pipeline onto the events queue,
 * consumed by the webhook dispatcher.
 */
export const zDomainEvent = z.object({
  type: zWebhookEventType,
  /** ISO timestamp of the observation that triggered the event. */
  occurredAt: z.iso.datetime({ offset: true }),
  cyclone: z.object({
    id: z.string(),
    pagasaName: z.string(),
    internationalName: z.string().nullable(),
    category: z.string().nullable(),
  }),
  bulletin: z
    .object({
      id: z.string(),
      bulletinNumber: z.number().int(),
      issuedAt: z.iso.datetime({ offset: true }),
    })
    .nullable(),
  /** Present for signal.raised / signal.lowered. */
  signal: z
    .object({
      psgcCode: z.string().nullable(),
      locationName: z.string(),
      previousLevel: zSignalLevel.nullable(),
      newLevel: zSignalLevel.nullable(),
    })
    .nullable(),
});
export type DomainEvent = z.infer<typeof zDomainEvent>;

export const QUEUE_NAMES = {
  ingest: 'bagyo:ingest',
  events: 'bagyo:events',
  webhooks: 'bagyo:webhooks',
} as const;
