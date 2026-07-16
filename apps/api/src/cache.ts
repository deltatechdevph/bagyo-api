import type { Redis } from 'ioredis';
import { CACHE_TTL_SECONDS } from '@bagyo/shared';

/**
 * Read-through JSON cache with a 60s TTL. The worker unlinks all bagyo:cache:*
 * keys the moment a new bulletin lands, so consumers never see stale signals
 * for longer than one poll cycle.
 */
export async function cached<T>(
  redis: Redis,
  key: string,
  produce: () => Promise<T>,
  ttlSeconds = CACHE_TTL_SECONDS,
): Promise<T> {
  const hit = await redis.get(key);
  if (hit !== null) return JSON.parse(hit) as T;
  const value = await produce();
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  return value;
}
