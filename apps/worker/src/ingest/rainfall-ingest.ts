import * as cheerio from 'cheerio';
import type { Logger } from 'pino';
import type { PrismaClient } from '@bagyo/db';
import {
  parsePagasaDateTime,
  resolveLocation,
  zParsedRainfallAdvisory,
  type Env,
  type ParsedRainfallAdvisory,
} from '@bagyo/shared';
import { CircuitOpenError, type PoliteFetcher } from '../fetcher.js';
import { sha256 } from '@bagyo/ingest';
import type { IngestSummary } from './bulletin-ingest.js';

export interface RainfallDeps {
  prisma: PrismaClient;
  fetcher: PoliteFetcher;
  env: Pick<Env, 'PAGASA_RAINFALL_URL'>;
  logger: Logger;
}

/**
 * Best-effort parser for PAGASA regional heavy-rainfall advisories.
 * PAGASA renders these as free-form regional pages, so this extracts
 * (level, issued time, area list) conservatively; pages that do not match
 * simply produce a SKIPPED run. Validated with Zod like every other parser.
 */
export function parseRainfallHtml(html: string, region: string): ParsedRainfallAdvisory[] {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');
  const advisories: ParsedRainfallAdvisory[] = [];

  const re = /(YELLOW|ORANGE|RED)\s+(?:warning|rainfall warning|rainfall advisory)[^.]{0,400}/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const level = (m[1] ?? '').toUpperCase() as 'YELLOW' | 'ORANGE' | 'RED';
    const issuedAt = parsePagasaDateTime(text.slice(Math.max(0, m.index - 400), m.index + 400));
    if (!issuedAt) continue;
    const segment = m[0] ?? '';
    const areaMatch = /over\s+(.{3,300}?)(?:\.|$)/i.exec(segment);
    const areas = (areaMatch?.[1] ?? '')
      .split(/,|\band\b/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 1)
      .map((name) => {
        const r = resolveLocation(name);
        return { psgcCode: r.psgcCode, name: r.name, raw: name };
      });
    if (areas.length === 0) continue;
    const candidate: ParsedRainfallAdvisory = { issuedAt, region, level, areas };
    const validated = zParsedRainfallAdvisory.safeParse(candidate);
    if (validated.success) advisories.push(validated.data);
  }
  return advisories;
}

export async function runRainfallIngest(deps: RainfallDeps): Promise<IngestSummary> {
  const { prisma, fetcher, env, logger } = deps;
  const run = await prisma.ingestRun.create({ data: { source: 'pagasa:rainfall' } });
  const finish = async (summary: IngestSummary) => {
    await prisma.ingestRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: summary.status,
        itemsFound: summary.itemsFound,
        itemsChanged: summary.itemsChanged,
        error: summary.error ?? null,
      },
    });
    return summary;
  };

  let page;
  try {
    page = await fetcher.fetch(env.PAGASA_RAINFALL_URL);
  } catch (err) {
    const msg = err instanceof CircuitOpenError ? err.message : String(err);
    logger.error({ err }, 'rainfall page fetch failed');
    return finish({ status: 'FAILED', itemsFound: 0, itemsChanged: 0, error: msg });
  }

  const advisories = parseRainfallHtml(page.body.toString('utf-8'), 'NCR-PRSD');
  if (advisories.length === 0) {
    return finish({ status: 'SKIPPED', itemsFound: 0, itemsChanged: 0 });
  }

  let changed = 0;
  for (const adv of advisories) {
    const hash = sha256(JSON.stringify([adv.region, adv.level, adv.issuedAt, adv.areas]));
    const exists = await prisma.rainfallAdvisory.findUnique({ where: { sourceHash: hash } });
    if (exists) continue;
    await prisma.rainfallAdvisory.create({
      data: {
        issuedAt: new Date(adv.issuedAt),
        region: adv.region,
        level: adv.level,
        areas: adv.areas,
        sourceUrl: env.PAGASA_RAINFALL_URL,
        sourceHash: hash,
        // Rainfall advisories are short-lived; treat as expired after 6 hours
        // unless superseded earlier.
        expiresAt: new Date(new Date(adv.issuedAt).getTime() + 6 * 3600_000),
      },
    });
    changed += 1;
  }
  return finish({ status: 'SUCCESS', itemsFound: advisories.length, itemsChanged: changed });
}
