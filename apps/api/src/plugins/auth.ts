import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_KEY_LOOKUP_PREFIX_LENGTH, API_KEY_PREFIX_LIVE } from '@bagyo/shared';
import type { AppDeps } from '../types.js';
import { unauthorized } from '../errors.js';
import { authenticateRapidApi } from './rapidapi.js';

/** Routes reachable without an API key. */
const PUBLIC_PREFIXES = ['/v1/health', '/ready', '/docs', '/metrics', '/v1/account/register'];

export function isPublicPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Bearer API-key authentication.
 * Keys are looked up by their stored prefix, then the SHA-256 of the presented
 * key is compared to the stored hash in constant time.
 */
export function registerAuth(app: FastifyInstance, deps: AppDeps): void {
  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (isPublicPath(req.url)) return;

    // RapidAPI-proxied traffic authenticates via the shared proxy secret.
    const rapid = await authenticateRapidApi(req, deps);
    if (rapid) {
      req.auth = rapid;
      return;
    }

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw unauthorized('Provide an API key: Authorization: Bearer bgy_live_…');
    }
    const key = header.slice('Bearer '.length).trim();
    if (!key.startsWith(API_KEY_PREFIX_LIVE) || key.length < API_KEY_LOOKUP_PREFIX_LENGTH + 8) {
      throw unauthorized();
    }

    const prefix = key.slice(0, API_KEY_LOOKUP_PREFIX_LENGTH);
    const record = await deps.prisma.apiKey.findUnique({ where: { prefix } });
    if (!record || record.revokedAt) throw unauthorized();

    const presented = createHash('sha256').update(key).digest();
    const stored = Buffer.from(record.hashedKey, 'hex');
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
      throw unauthorized();
    }

    req.auth = { keyId: record.id, userId: record.userId, tier: record.tier };

    // Track lastUsedAt at most once per minute per key; never block the request on it.
    if (!record.lastUsedAt || Date.now() - record.lastUsedAt.getTime() > 60_000) {
      deps.prisma.apiKey
        .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
        .catch((err: unknown) => req.log.warn({ err }, 'lastUsedAt update failed'));
    }
  });
}
