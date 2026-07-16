import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  APP_SECRET: 'x'.repeat(32),
};

describe('env schema', () => {
  it('accepts a minimal valid config and applies defaults', () => {
    const env = parseEnv({ ...valid });
    expect(env.API_PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.INGEST_ENABLED).toBe(true);
  });

  it('splits CORS origins', () => {
    const env = parseEnv({ ...valid, CORS_ORIGINS: 'https://a.com, https://b.com' });
    expect(env.CORS_ORIGINS).toEqual(['https://a.com', 'https://b.com']);
  });

  it('rejects a short APP_SECRET', () => {
    expect(() => parseEnv({ ...valid, APP_SECRET: 'short' })).toThrow();
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: 'mysql://x' })).toThrow();
  });

  it('coerces API_PORT and rejects out-of-range values', () => {
    expect(parseEnv({ ...valid, API_PORT: '8080' }).API_PORT).toBe(8080);
    expect(() => parseEnv({ ...valid, API_PORT: '99999' })).toThrow();
  });
});
