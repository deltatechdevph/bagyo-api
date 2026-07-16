import { z } from 'zod';

const zEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  SCRAPER_USER_AGENT: z.string().min(1).default('BagyoAPI/1.0 (+https://bagyo-api.example.com)'),
  PAGASA_BULLETIN_URL: z
    .url()
    .default('https://www.pagasa.dost.gov.ph/tropical-cyclone/severe-weather-bulletin'),
  PAGASA_PDF_INDEX_URL: z
    .url()
    .default('https://pubfiles.pagasa.dost.gov.ph/tamss/weather/bulletin/'),
  PAGASA_RAINFALL_URL: z.url().default('https://www.pagasa.dost.gov.ph/regional-forecast/ncrprsd'),
  INGEST_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
});

export type Env = z.infer<typeof zEnv>;

/**
 * Validate configuration at boot. The process must refuse to start with
 * missing/invalid config, so this prints every problem and exits non-zero.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = zEnv.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    console.error(`Invalid environment configuration:\n${lines.join('\n')}`);
    process.exit(1);
  }
  return parsed.data;
}

/** Non-exiting variant for tests. */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  return zEnv.parse(source);
}
