export const CYCLONE_CATEGORIES = ['TD', 'TS', 'STS', 'TY', 'STY'] as const;
export type CycloneCategory = (typeof CYCLONE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<CycloneCategory, string> = {
  TD: 'Tropical Depression',
  TS: 'Tropical Storm',
  STS: 'Severe Tropical Storm',
  TY: 'Typhoon',
  STY: 'Super Typhoon',
};

export const CYCLONE_STATUSES = ['ACTIVE', 'EXITED', 'DISSIPATED'] as const;
export type CycloneStatus = (typeof CYCLONE_STATUSES)[number];

export const SIGNAL_LEVELS = [1, 2, 3, 4, 5] as const;
export type SignalLevel = (typeof SIGNAL_LEVELS)[number];

export const RAINFALL_LEVELS = ['YELLOW', 'ORANGE', 'RED'] as const;
export type RainfallLevel = (typeof RAINFALL_LEVELS)[number];

export const API_TIERS = ['FREE', 'HOBBY', 'PRO', 'BUSINESS'] as const;
export type ApiTier = (typeof API_TIERS)[number];

/** Requests per day. BUSINESS is "custom" — this is the default ceiling. */
export const TIER_DAILY_LIMITS: Record<ApiTier, number> = {
  FREE: 100,
  HOBBY: 5_000,
  PRO: 100_000,
  BUSINESS: 1_000_000,
};

export const WEBHOOK_EVENT_TYPES = [
  'cyclone.entered_par',
  'cyclone.exited_par',
  'bulletin.issued',
  'signal.raised',
  'signal.lowered',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Exponential-ish backoff for webhook delivery: 1m, 5m, 30m, 2h, 12h. */
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000] as const;

export const WEBHOOK_MAX_CONSECUTIVE_FAILURES = 20;

/** Anonymous (keyless) requests share this per-IP daily quota. */
export const ANON_DAILY_LIMIT = 10_000;

export const API_KEY_PREFIX_LIVE = 'bgy_live_';
/** Stored, indexable prefix length (includes bgy_live_). */
export const API_KEY_LOOKUP_PREFIX_LENGTH = 17;

export const ATTRIBUTION = 'DOST-PAGASA';

export const DISCLAIMER =
  'BagyoAPI is an independent service and is not affiliated with or endorsed by PAGASA or DOST. ' +
  'Data is derived from public DOST-PAGASA bulletins and may lag or contain parsing errors. ' +
  'Do not use as the sole source for life-safety decisions — always defer to official PAGASA channels.';

export const DOCS_BASE_URL = 'https://bagyo-api.example.com/docs';

/** Redis cache keys shared by the API (reader) and worker (invalidator). */
export const CACHE_PREFIX = 'bagyo:cache:';
export const CACHE_KEYS = {
  cyclonesActive: `${CACHE_PREFIX}cyclones:active`,
  signalsCurrent: `${CACHE_PREFIX}signals:current`,
  bulletinsLatest: `${CACHE_PREFIX}bulletins:latest`,
  rainfallCurrent: `${CACHE_PREFIX}rainfall:current`,
  signalsLookup: (key: string) => `${CACHE_PREFIX}signals:lookup:${key}`,
} as const;
export const CACHE_TTL_SECONDS = 60;
