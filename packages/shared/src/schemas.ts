import { z } from 'zod';
import {
  API_TIERS,
  CYCLONE_CATEGORIES,
  CYCLONE_STATUSES,
  RAINFALL_LEVELS,
  WEBHOOK_EVENT_TYPES,
} from './constants.js';

export const zCycloneCategory = z.enum(CYCLONE_CATEGORIES);
export const zCycloneStatus = z.enum(CYCLONE_STATUSES);
export const zRainfallLevel = z.enum(RAINFALL_LEVELS);
export const zApiTier = z.enum(API_TIERS);
export const zWebhookEventType = z.enum(WEBHOOK_EVENT_TYPES);
export const zSignalLevel = z.number().int().min(1).max(5);

export const zLocationType = z.enum(['PROVINCE', 'MUNICIPALITY', 'CITY', 'ISLAND', 'UNKNOWN']);

/** One area under a wind signal, aligned with the WindSignal DB row. */
export const zParsedSignalArea = z.object({
  psgcCode: z.string().nullable(),
  locationName: z.string().min(1),
  locationType: zLocationType,
  /** e.g. "northern portion", null when the whole unit is covered. */
  partialDescriptor: z.string().nullable(),
  /** The verbatim source phrase this area was extracted from. */
  raw: z.string(),
  /** Luzon / Visayas / Mindanao column the area appeared under, when known. */
  islandGroup: z.enum(['luzon', 'visayas', 'mindanao']).nullable(),
});
export type ParsedSignalArea = z.infer<typeof zParsedSignalArea>;

export const zParsedWindSignal = z.object({
  signalLevel: zSignalLevel,
  areas: z.array(zParsedSignalArea),
});
export type ParsedWindSignal = z.infer<typeof zParsedWindSignal>;

/**
 * Canonical parser output for one PAGASA tropical cyclone bulletin.
 * Meteorological fields are null when absent from the source — never estimated.
 */
export const zParsedBulletin = z.object({
  source: z.enum(['html', 'pdf']),
  /** Bulletin number, e.g. 10. Final bulletins ("NR. 16F") set isFinal. */
  bulletinNumber: z.number().int().positive(),
  isFinal: z.boolean(),
  /** PAGASA local name, uppercased, e.g. "INDAY". */
  pagasaName: z.string().min(1),
  /** International name, e.g. "BAVI"; null when PAGASA omits it. */
  internationalName: z.string().nullable(),
  /**
   * TC category at issuance. Null when the system is no longer a tropical cyclone
   * (e.g. "Low Pressure Area (formerly INDAY)").
   */
  category: zCycloneCategory.nullable(),
  /** Raw category text as printed, e.g. "Super Typhoon", "Low Pressure Area". */
  categoryRaw: z.string(),
  issuedAt: z.iso.datetime({ offset: true }),
  nextBulletinAt: z.iso.datetime({ offset: true }).nullable(),
  headline: z.string().nullable(),
  center: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(0).max(360),
      description: z.string().nullable(),
      outsidePar: z.boolean(),
    })
    .nullable(),
  maxWindsKph: z.number().int().positive().nullable(),
  gustinessKph: z.number().int().positive().nullable(),
  pressureHpa: z.number().positive().nullable(),
  movementDirection: z.string().nullable(),
  movementSpeedKph: z.number().nonnegative().nullable(),
  signals: z.array(zParsedWindSignal),
});
export type ParsedBulletin = z.infer<typeof zParsedBulletin>;

export const zParsedRainfallAdvisory = z.object({
  issuedAt: z.iso.datetime({ offset: true }),
  region: z.string(),
  level: zRainfallLevel,
  areas: z.array(
    z.object({
      psgcCode: z.string().nullable(),
      name: z.string(),
      raw: z.string(),
    }),
  ),
});
export type ParsedRainfallAdvisory = z.infer<typeof zParsedRainfallAdvisory>;
