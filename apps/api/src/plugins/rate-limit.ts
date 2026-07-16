import type { FastifyInstance } from 'fastify';
import { TIER_DAILY_LIMITS } from '@bagyo/shared';
import type { AppDeps } from '../types.js';
import { rateLimited } from '../errors.js';
import { isPublicPath } from './auth.js';

const DAY_MS = 24 * 3600_000;

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the sliding window frees capacity (approx: end of current day bucket). */
  resetSeconds: number;
}

/**
 * Sliding-window-counter rate limiting (per key, daily quotas).
 * Two fixed UTC-day buckets per key; the previous bucket is weighted by its
 * overlap with the rolling 24h window. O(1) memory per key, small bounded error.
 */
export async function decide(
  redis: AppDeps['redis'],
  keyId: string,
  limit: number,
  now = Date.now(),
): Promise<RateDecision> {
  const day = Math.floor(now / DAY_MS);
  const elapsed = now - day * DAY_MS;
  const currKey = `bagyo:rl:${keyId}:${day}`;
  const prevKey = `bagyo:rl:${keyId}:${day - 1}`;

  const [currRaw, prevRaw] = await redis.mget(currKey, prevKey);
  const curr = Number(currRaw ?? 0);
  const prev = Number(prevRaw ?? 0);
  const weight = (DAY_MS - elapsed) / DAY_MS;
  const estimated = curr + prev * weight;

  const resetSeconds = Math.max(1, Math.ceil((DAY_MS - elapsed) / 1000));
  if (estimated >= limit) {
    return { allowed: false, limit, remaining: 0, resetSeconds };
  }

  const next = await redis.incr(currKey);
  if (next === 1) await redis.expire(currKey, 2 * 24 * 3600);
  const remaining = Math.max(0, Math.floor(limit - (estimated + 1)));
  return { allowed: true, limit, remaining, resetSeconds };
}

export function registerRateLimit(app: FastifyInstance, deps: AppDeps): void {
  app.addHook('onRequest', async (req, reply) => {
    if (isPublicPath(req.url) || !req.auth) return;
    const limit = TIER_DAILY_LIMITS[req.auth.tier];
    const decision = await decide(deps.redis, req.auth.keyId, limit);
    void reply.header('x-ratelimit-limit', decision.limit);
    void reply.header('x-ratelimit-remaining', decision.remaining);
    void reply.header('x-ratelimit-reset', decision.resetSeconds);
    if (!decision.allowed) {
      throw rateLimited(decision.resetSeconds);
    }
  });
}
