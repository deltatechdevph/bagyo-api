import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CACHE_KEYS, getMunicipality, normalizeName, resolveLocation } from '@bagyo/shared';
import type { AppDeps } from '../types.js';
import { ApiError } from '../errors.js';
import { cached } from '../cache.js';
import { envelope, wrap, zErrorEnvelope, zIsoDate } from '../schemas.js';
import { iso } from '../schemas.js';

const zSignalContext = z.object({
  cyclone: z.object({
    id: z.string(),
    pagasaName: z.string(),
    internationalName: z.string().nullable(),
    category: z.string(),
  }),
  bulletin: z.object({ id: z.string(), bulletinNumber: z.number().int(), issuedAt: zIsoDate }),
});

const zCurrentSignalArea = z.object({
  psgcCode: z.string().nullable(),
  locationName: z.string(),
  locationType: z.string(),
  partialDescriptor: z.string().nullable(),
  context: zSignalContext,
});

interface CurrentSignalRow {
  signalLevel: number;
  psgcCode: string | null;
  locationName: string;
  locationType: string;
  partialDescriptor: string | null;
  context: z.infer<typeof zSignalContext>;
}

/** All wind signals in effect = signals of the latest bulletin per ACTIVE cyclone. */
async function currentSignalRows(deps: AppDeps): Promise<CurrentSignalRow[]> {
  const active = await deps.prisma.cyclone.findMany({
    where: { status: 'ACTIVE' },
    include: {
      bulletins: { orderBy: { issuedAt: 'desc' }, take: 1, include: { windSignals: true } },
    },
  });
  const rows: CurrentSignalRow[] = [];
  for (const cyclone of active) {
    const bulletin = cyclone.bulletins[0];
    if (!bulletin || bulletin.isFinal) continue;
    for (const w of bulletin.windSignals) {
      rows.push({
        signalLevel: w.signalLevel,
        psgcCode: w.psgcCode,
        locationName: w.locationName,
        locationType: w.locationType,
        partialDescriptor: w.partialDescriptor,
        context: {
          cyclone: {
            id: cyclone.id,
            pagasaName: cyclone.pagasaName,
            internationalName: cyclone.internationalName,
            category: cyclone.category,
          },
          bulletin: {
            id: bulletin.id,
            bulletinNumber: bulletin.bulletinNumber,
            issuedAt: iso(bulletin.issuedAt),
          },
        },
      });
    }
  }
  return rows;
}

export function registerSignalRoutes(fastify: FastifyInstance, deps: AppDeps): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get(
    '/v1/signals/current',
    {
      schema: {
        tags: ['signals'],
        summary: 'All wind signals currently in effect, grouped by level',
        response: {
          200: envelope(
            z.object({
              inEffect: z.boolean(),
              byLevel: z.record(z.string(), z.array(zCurrentSignalArea)),
            }),
          ),
          401: zErrorEnvelope,
        },
      },
    },
    async () =>
      cached(deps.redis, CACHE_KEYS.signalsCurrent, async () => {
        const rows = await currentSignalRows(deps);
        const byLevel: Record<string, Omit<CurrentSignalRow, 'signalLevel'>[]> = {};
        for (const { signalLevel, ...rest } of rows) {
          (byLevel[String(signalLevel)] ??= []).push(rest);
        }
        return wrap({ inEffect: rows.length > 0, byLevel });
      }),
  );

  app.get(
    '/v1/signals/lookup',
    {
      schema: {
        tags: ['signals'],
        summary: 'Current wind signal for a specific location (fast, cached)',
        description:
          'Query by PSGC code (`?psgc=012800000`) or free-text name (`?q=Bulacan`). ' +
          'Returns the highest signal level currently covering the location, including ' +
          'signals inherited from a parent province.',
        querystring: z
          .object({
            psgc: z
              .string()
              .regex(/^\d{9}$/)
              .optional(),
            q: z.string().min(2).max(120).optional(),
          })
          .strict()
          .refine((v) => Boolean(v.psgc) !== Boolean(v.q), {
            message: 'Provide exactly one of ?psgc= or ?q=',
          }),
        response: {
          200: envelope(
            z.object({
              query: z.object({
                psgcCode: z.string().nullable(),
                matchedName: z.string().nullable(),
                locationType: z.string().nullable(),
              }),
              signal: z
                .object({
                  level: z.number().int(),
                  coverage: z.enum(['direct', 'parent-province', 'name-match']),
                  partialDescriptor: z.string().nullable(),
                  context: zSignalContext,
                })
                .nullable(),
            }),
          ),
          401: zErrorEnvelope,
          422: zErrorEnvelope,
        },
      },
    },
    async (req) => {
      const { psgc, q } = req.query;
      const cacheKey = CACHE_KEYS.signalsLookup(psgc ?? `q:${normalizeName(q ?? '')}`);
      return cached(deps.redis, cacheKey, async () => {
        const resolved = psgc
          ? { psgcCode: psgc, name: null as string | null, locationType: null as string | null }
          : (() => {
              const r = resolveLocation(q ?? '');
              return { psgcCode: r.psgcCode, name: r.name, locationType: r.locationType };
            })();

        if (psgc && !getMunicipality(psgc) && !isProvinceCode(psgc)) {
          throw new ApiError(422, 'UNKNOWN_PSGC', `Unknown PSGC code ${psgc}`, '#psgc-codes');
        }

        const rows = await cached(deps.redis, CACHE_KEYS.signalsCurrent + ':raw', () =>
          currentSignalRows(deps),
        );

        const best = pickSignal(rows, resolved.psgcCode, q ?? null);
        return wrap({
          query: {
            psgcCode: resolved.psgcCode,
            matchedName: resolved.name,
            locationType: resolved.locationType,
          },
          signal: best,
        });
      });
    },
  );

  registerRainfallRoute(app, deps);
}

function isProvinceCode(code: string): boolean {
  return code.endsWith('00000');
}

function pickSignal(
  rows: CurrentSignalRow[],
  psgcCode: string | null,
  q: string | null,
): {
  level: number;
  coverage: 'direct' | 'parent-province' | 'name-match';
  partialDescriptor: string | null;
  context: CurrentSignalRow['context'];
} | null {
  let best: ReturnType<typeof pickSignal> = null;
  const SPECIFICITY = { direct: 2, 'name-match': 1, 'parent-province': 0 } as const;
  const consider = (
    row: CurrentSignalRow,
    coverage: 'direct' | 'parent-province' | 'name-match',
  ) => {
    // Higher signal level wins; at equal levels, an explicit listing of the
    // location beats coverage inherited from its parent province.
    if (
      !best ||
      row.signalLevel > best.level ||
      (row.signalLevel === best.level && SPECIFICITY[coverage] > SPECIFICITY[best.coverage])
    ) {
      best = {
        level: row.signalLevel,
        coverage,
        partialDescriptor: row.partialDescriptor,
        context: row.context,
      };
    }
  };

  if (psgcCode) {
    const parentProvince = getMunicipality(psgcCode)?.provinceCode ?? null;
    for (const row of rows) {
      if (row.psgcCode === psgcCode) consider(row, 'direct');
      // A signal hoisted over a whole province covers its municipalities.
      else if (parentProvince && row.psgcCode === parentProvince) consider(row, 'parent-province');
    }
  } else if (q) {
    const needle = normalizeName(q);
    for (const row of rows) {
      if (normalizeName(row.locationName).includes(needle)) consider(row, 'name-match');
    }
  }
  return best;
}

const zRainfallAdvisory = z.object({
  id: z.string(),
  issuedAt: zIsoDate,
  region: z.string(),
  level: z.enum(['YELLOW', 'ORANGE', 'RED']),
  areas: z.array(z.object({ psgcCode: z.string().nullable(), name: z.string(), raw: z.string() })),
  expiresAt: zIsoDate.nullable(),
});

function registerRainfallRoute(fastify: FastifyInstance, deps: AppDeps): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get(
    '/v1/rainfall/current',
    {
      schema: {
        tags: ['rainfall'],
        summary: 'Active rainfall advisories',
        response: {
          200: envelope(z.object({ advisories: z.array(zRainfallAdvisory) })),
          401: zErrorEnvelope,
        },
      },
    },
    async () =>
      cached(deps.redis, CACHE_KEYS.rainfallCurrent, async () => {
        const advisories = await deps.prisma.rainfallAdvisory.findMany({
          where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          orderBy: { issuedAt: 'desc' },
          take: 100,
        });
        return wrap({
          advisories: advisories.map((a) => ({
            id: a.id,
            issuedAt: iso(a.issuedAt),
            region: a.region,
            level: a.level,
            areas: a.areas as { psgcCode: string | null; name: string; raw: string }[],
            expiresAt: a.expiresAt ? iso(a.expiresAt) : null,
          })),
        });
      }),
  );
}
