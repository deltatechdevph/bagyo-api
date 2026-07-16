/**
 * Seed script — makes the API demo-able with zero live scraping:
 *  - a demo user with a deterministic PRO API key (printed once)
 *  - the bundled real PAGASA fixture bulletins ingested through the actual
 *    parser + persistence pipeline (Typhoon INDAY and STS/TY FRANCISCO, 2026)
 *
 * Idempotent: hashes dedupe bulletins, upserts dedupe the user/key.
 * Run with: node apps/worker/dist/seed.js  (or `pnpm db:seed` from the root)
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPrisma, disconnectPrisma } from '@bagyo/db';
import { parseBulletinPdf, PARSER_VERSION } from '@bagyo/parser';
import { persistBulletin, sha256 } from '@bagyo/ingest';

export const DEMO_API_KEY = 'bgy_live_demo0000000000000000000000000000';

function fixturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, '../../../fixtures'), // src layout & container layout
    join(here, '../../fixtures'),
    join(process.cwd(), 'fixtures'),
  ]) {
    if (existsSync(join(candidate, 'pdf'))) return candidate;
  }
  throw new Error('fixtures/ directory not found');
}

async function main(): Promise<void> {
  const prisma = getPrisma();

  const user = await prisma.user.upsert({
    where: { email: 'demo@bagyo-api.local' },
    create: {
      email: 'demo@bagyo-api.local',
      // argon2id hash of "demo-password" (precomputed; seeding must not need native argon2).
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

  const dir = join(fixturesDir(), 'pdf');
  let ingested = 0;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.pdf')) continue;
    const bytes = new Uint8Array(readFileSync(join(dir, file)));
    try {
      const { bulletin, issues } = await parseBulletinPdf(bytes, `fixture://${file}`);
      const result = await persistBulletin(prisma, bulletin, {
        sourceUrl: `fixture://${file}`,
        sourceHash: sha256(Buffer.from(bytes)),
        parserVersion: PARSER_VERSION,
      });
      if (result.outcome !== 'unchanged') ingested += 1;
      if (issues.length > 0) {
        console.warn(`  ${file}: ${issues.length} unresolved area name(s) kept as raw text`);
      }
    } catch (err) {
      console.error(`  ${file}: failed to ingest —`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`Seeded ${ingested} fixture bulletin(s) (idempotent re-runs are no-ops)`);
  console.log('Demo user: demo@bagyo-api.local / demo-password');
  console.log(`Demo API key (PRO tier): ${DEMO_API_KEY}`);
  console.log(
    'Try: curl -H "Authorization: Bearer <key>" http://localhost:3000/v1/cyclones/active',
  );
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => void disconnectPrisma());
