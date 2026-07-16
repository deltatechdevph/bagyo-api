import type { Logger } from 'pino';
import type { PrismaClient } from '@bagyo/db';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import {
  BulletinParseError,
  PARSER_VERSION,
  parseBulletinHtml,
  parseBulletinPdf,
} from '@bagyo/parser';
import type { DomainEvent, Env } from '@bagyo/shared';
import { CircuitOpenError, FetchError, type PoliteFetcher } from '../fetcher.js';
import { persistBulletin, sha256 } from '@bagyo/ingest';
import { invalidateApiCache } from '../cache.js';

export interface IngestDeps {
  prisma: PrismaClient;
  redis: Redis;
  fetcher: PoliteFetcher;
  eventsQueue: Queue;
  env: Pick<Env, 'PAGASA_BULLETIN_URL' | 'PAGASA_PDF_INDEX_URL'>;
  logger: Logger;
}

export interface IngestSummary {
  status: 'SUCCESS' | 'SKIPPED' | 'FAILED';
  itemsFound: number;
  itemsChanged: number;
  error?: string;
}

const LAST_HASH_KEY = 'bagyo:ingest:last-hash:bulletin-page';

/**
 * One polling run of the tropical cyclone bulletin page.
 * HTML is the primary source; on HTML parse failure, falls back to the PDF
 * links found on the page. One bad bulletin never halts the pipeline.
 */
export async function runBulletinIngest(deps: IngestDeps): Promise<IngestSummary> {
  const { prisma, redis, fetcher, env, logger } = deps;
  const run = await prisma.ingestRun.create({ data: { source: 'pagasa:html' } });
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
    page = await fetcher.fetch(env.PAGASA_BULLETIN_URL);
  } catch (err) {
    const msg = err instanceof CircuitOpenError ? err.message : `fetch failed: ${String(err)}`;
    logger.error({ err }, 'bulletin page fetch failed');
    return finish({ status: 'FAILED', itemsFound: 0, itemsChanged: 0, error: msg });
  }

  const html = page.body.toString('utf-8');
  const pageHash = sha256(page.body);
  const lastHash = await redis.get(LAST_HASH_KEY);
  if (lastHash === pageHash) {
    return finish({ status: 'SKIPPED', itemsFound: 0, itemsChanged: 0 });
  }

  let itemsFound = 0;
  let itemsChanged = 0;
  const allEvents: DomainEvent[] = [];
  const errors: string[] = [];

  try {
    const { bulletins, issues } = parseBulletinHtml(html, env.PAGASA_BULLETIN_URL);
    for (const issue of issues) {
      logger.warn({ issue }, 'unresolvable area name (stored with psgcCode=null)');
    }
    itemsFound = bulletins.length;
    for (const parsed of bulletins) {
      // Hash per (bulletin content identity), not the whole page, so unrelated
      // page churn does not defeat idempotency.
      const contentHash = sha256(
        JSON.stringify([parsed.pagasaName, parsed.bulletinNumber, parsed.issuedAt, parsed.signals]),
      );
      const result = await persistBulletin(prisma, parsed, {
        sourceUrl: env.PAGASA_BULLETIN_URL,
        sourceHash: contentHash,
        parserVersion: PARSER_VERSION,
        rawDocument: html,
      });
      if (result.outcome !== 'unchanged') {
        itemsChanged += 1;
        allEvents.push(...result.events);
      }
    }
  } catch (err) {
    if (err instanceof BulletinParseError) {
      logger.warn({ err: err.message, details: err.details }, 'HTML parse failed — PDF fallback');
      try {
        const viaPdf = await ingestViaPdfFallback(deps, html);
        itemsFound += viaPdf.itemsFound;
        itemsChanged += viaPdf.itemsChanged;
        allEvents.push(...viaPdf.events);
        if (viaPdf.errors.length > 0) errors.push(...viaPdf.errors);
      } catch (pdfErr) {
        errors.push(`html: ${err.message}; pdf fallback: ${String(pdfErr)}`);
      }
    } else {
      errors.push(String(err));
    }
  }

  if (itemsChanged > 0) {
    await invalidateApiCache(redis);
    for (const event of allEvents) {
      await deps.eventsQueue.add(event.type, event, {
        removeOnComplete: 1000,
        removeOnFail: 5000,
      });
    }
    logger.info({ itemsChanged, events: allEvents.length }, 'bulletins ingested');
  }

  // Only remember the page hash on a fully clean run, so failures are retried.
  if (errors.length === 0) {
    await redis.set(LAST_HASH_KEY, pageHash, 'EX', 24 * 3600);
  }

  if (errors.length > 0) {
    return finish({
      status: 'FAILED',
      itemsFound,
      itemsChanged,
      error: errors.join(' | ').slice(0, 2000),
    });
  }
  return finish({ status: 'SUCCESS', itemsFound, itemsChanged });
}

interface PdfFallbackResult {
  itemsFound: number;
  itemsChanged: number;
  events: DomainEvent[];
  errors: string[];
}

/** Pull per-cyclone PDF links out of the page (works even when its markup breaks). */
export function extractPdfLinks(html: string, indexUrl: string): string[] {
  const links = new Set<string>();
  const re = /href\s*=\s*["']([^"']*(?:bulletin|tcb)[^"']*\.pdf)["']/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const href = m[1];
    if (!href) continue;
    try {
      links.add(new URL(href, indexUrl).toString());
    } catch {
      // ignore malformed URLs
    }
  }
  return [...links];
}

async function ingestViaPdfFallback(deps: IngestDeps, html: string): Promise<PdfFallbackResult> {
  const { fetcher, prisma, env, logger } = deps;
  const links = extractPdfLinks(html, env.PAGASA_PDF_INDEX_URL);
  const out: PdfFallbackResult = { itemsFound: 0, itemsChanged: 0, events: [], errors: [] };
  if (links.length === 0) {
    out.errors.push('pdf fallback: no bulletin PDF links found on page');
    return out;
  }
  for (const url of links) {
    try {
      const doc = await fetcher.fetch(url);
      const hash = sha256(doc.body);
      const existing = await prisma.bulletin.findUnique({ where: { sourceHash: hash } });
      if (existing) continue;
      const { bulletin: parsed, issues } = await parseBulletinPdf(new Uint8Array(doc.body), url);
      for (const issue of issues) {
        logger.warn({ issue, url }, 'unresolvable area name in PDF');
      }
      out.itemsFound += 1;
      const result = await persistBulletin(prisma, parsed, {
        sourceUrl: url,
        sourceHash: hash,
        parserVersion: PARSER_VERSION,
      });
      if (result.outcome !== 'unchanged') {
        out.itemsChanged += 1;
        out.events.push(...result.events);
      }
    } catch (err) {
      // One bad PDF must not halt the rest.
      if (err instanceof FetchError || err instanceof BulletinParseError) {
        out.errors.push(`${url}: ${err.message}`);
      } else if (err instanceof CircuitOpenError) {
        out.errors.push(err.message);
        break;
      } else {
        out.errors.push(`${url}: ${String(err)}`);
      }
    }
  }
  return out;
}
