import type { Redis } from 'ioredis';
import { CACHE_PREFIX } from '@bagyo/shared';

/**
 * Invalidate every API cache entry immediately after a new bulletin lands.
 * SCAN + UNLINK keeps Redis responsive regardless of key count.
 */
export async function invalidateApiCache(redis: Redis): Promise<number> {
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${CACHE_PREFIX}*`, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) {
      removed += await redis.unlink(...keys);
    }
  } while (cursor !== '0');
  return removed;
}
