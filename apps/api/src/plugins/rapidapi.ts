import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { ApiTier } from '@bagyo/shared';
import type { AppDeps, AuthContext } from '../types.js';
import { unauthorized } from '../errors.js';

/**
 * RapidAPI marketplace support.
 *
 * When listed on RapidAPI, requests arrive through their proxy carrying:
 *   X-RapidAPI-Proxy-Secret  — shared secret proving the request came from RapidAPI
 *   X-RapidAPI-User          — the marketplace username of the subscriber
 *   X-RapidAPI-Subscription  — the plan name (BASIC / PRO / ULTRA / MEGA by default)
 *
 * RapidAPI manages subscriber keys and billing; we verify the proxy secret in
 * constant time, auto-provision a local User per marketplace subscriber (so
 * webhooks and keys still work), and map their plan onto our tiers. Our own
 * rate limiter stays on as a safety ceiling — configure RapidAPI plan quotas
 * to match (see README).
 */

/** RapidAPI default plan names → BagyoAPI tiers. */
const PLAN_TO_TIER: Record<string, ApiTier> = {
  BASIC: 'FREE',
  PRO: 'HOBBY',
  ULTRA: 'PRO',
  MEGA: 'BUSINESS',
};

export function tierForRapidApiPlan(plan: string | undefined): ApiTier {
  return PLAN_TO_TIER[(plan ?? '').trim().toUpperCase()] ?? 'FREE';
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Deterministic internal email for a marketplace subscriber. */
export function rapidApiEmail(username: string): string {
  const slug = username
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return `${slug || 'user'}@subscribers.rapidapi.local`;
}

/**
 * Try to authenticate a request as RapidAPI-proxied traffic.
 * Returns null when the request is not RapidAPI traffic (no secret header or
 * the feature is disabled) so the caller can fall through to bearer-key auth.
 * Throws 401 when a secret is presented but invalid.
 */
export async function authenticateRapidApi(
  req: FastifyRequest,
  deps: AppDeps,
): Promise<AuthContext | null> {
  const configured = deps.env.RAPIDAPI_PROXY_SECRET;
  const presented = req.headers['x-rapidapi-proxy-secret'];
  if (!configured || typeof presented !== 'string' || presented.length === 0) return null;

  if (!constantTimeEquals(presented, configured)) {
    throw unauthorized('Invalid RapidAPI proxy secret');
  }

  const username = req.headers['x-rapidapi-user'];
  if (typeof username !== 'string' || username.trim().length === 0) {
    throw unauthorized('Missing X-RapidAPI-User header');
  }

  const email = rapidApiEmail(username.trim());
  const user =
    (await deps.prisma.user.findUnique({ where: { email } })) ??
    (await deps.prisma.user.create({
      data: {
        email,
        // Marketplace subscribers authenticate via RapidAPI only — no usable password.
        passwordHash: '!rapidapi-managed',
      },
    }));

  const plan = req.headers['x-rapidapi-subscription'];
  const tier = tierForRapidApiPlan(typeof plan === 'string' ? plan : undefined);

  return { keyId: `rapidapi:${user.id}`, userId: user.id, tier };
}
