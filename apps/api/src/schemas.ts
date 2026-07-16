import { z } from 'zod';
import { ATTRIBUTION, DISCLAIMER, zApiTier, zWebhookEventType } from '@bagyo/shared';

/** Every successful response carries attribution + the safety disclaimer. */
export function envelope<T extends z.ZodType>(data: T) {
  return z.object({
    data,
    source: z.literal(ATTRIBUTION),
    disclaimer: z.literal(DISCLAIMER),
  });
}

export function wrap<T>(data: T) {
  return { data, source: ATTRIBUTION, disclaimer: DISCLAIMER } as const;
}

export const zErrorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string(), docs: z.string() }),
});

export const zIsoDate = z.iso.datetime({ offset: true });

export const zCycloneSummary = z.object({
  id: z.string(),
  pagasaName: z.string(),
  internationalName: z.string().nullable(),
  category: z.string(),
  categoryLabel: z.string(),
  status: z.string(),
  seasonYear: z.number().int(),
  firstBulletinAt: zIsoDate,
  lastBulletinAt: zIsoDate,
});

export const zSignalArea = z.object({
  signalLevel: z.number().int(),
  psgcCode: z.string().nullable(),
  locationName: z.string(),
  locationType: z.string(),
  partialDescriptor: z.string().nullable(),
});

export const zBulletinSummary = z.object({
  id: z.string(),
  bulletinNumber: z.number().int(),
  isFinal: z.boolean(),
  issuedAt: zIsoDate,
  nextBulletinAt: zIsoDate.nullable(),
  center: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  maxWindsKph: z.number().nullable(),
  gustinessKph: z.number().nullable(),
  pressureHpa: z.number().nullable(),
  movementDirection: z.string().nullable(),
  movementSpeedKph: z.number().nullable(),
  sourceUrl: z.string(),
});

export const zBulletinWithSignals = zBulletinSummary.extend({
  windSignals: z.array(zSignalArea),
});

export const zActiveCyclone = zCycloneSummary.extend({
  latestBulletin: zBulletinWithSignals.nullable(),
});

export const zPagination = z.object({
  nextCursor: z.string().nullable(),
});

export const zWebhookSubscription = z.object({
  id: z.string(),
  targetUrl: z.string(),
  eventTypes: z.array(zWebhookEventType),
  psgcFilter: z.array(z.string()),
  minSignalLevel: z.number().int(),
  active: z.boolean(),
  failureCount: z.number().int(),
  createdAt: zIsoDate,
});

export const zApiKeyPublic = z.object({
  id: z.string(),
  prefix: z.string(),
  tier: zApiTier,
  name: z.string().nullable(),
  createdAt: zIsoDate,
  revokedAt: zIsoDate.nullable(),
  lastUsedAt: zIsoDate.nullable(),
});

export const iso = (d: Date): string => d.toISOString();
