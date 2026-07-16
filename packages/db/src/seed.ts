/**
 * Seed script — loads demo data so the API is usable with zero live scraping:
 *  - a demo user with a deterministic demo API key (printed once)
 *  - fixture bulletins ingested through the real parser (added in Phase 2+)
 *
 * Idempotent: safe to run repeatedly.
 */
import { createHash } from 'node:crypto';
import { getPrisma, disconnectPrisma } from './index.js';

export const DEMO_API_KEY = 'bgy_live_demo0000000000000000000000000000';

async function main(): Promise<void> {
  const prisma = getPrisma();

  const user = await prisma.user.upsert({
    where: { email: 'demo@bagyo-api.local' },
    create: {
      email: 'demo@bagyo-api.local',
      // argon2id hash of "demo-password" (precomputed; seed must not depend on native argon2).
      passwordHash:
        '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1kZW1vLXNhbHQ$We2/E+eYTC2eNqdMzp2eA5cV1c9WvMAG7tCzTFYikBM',
    },
    update: {},
  });

  const hashedKey = createHash('sha256').update(DEMO_API_KEY).digest('hex');
  await prisma.apiKey.upsert({
    where: { prefix: DEMO_API_KEY.slice(0, 17) },
    create: {
      userId: user.id,
      prefix: DEMO_API_KEY.slice(0, 17),
      hashedKey,
      tier: 'PRO',
      name: 'Demo key (seeded)',
    },
    update: { hashedKey, revokedAt: null },
  });

  console.log('Seeded demo user demo@bagyo-api.local');
  console.log(`Demo API key (PRO tier): ${DEMO_API_KEY}`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => void disconnectPrisma());
