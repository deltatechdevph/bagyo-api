import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import {
  parsePagasaDateTime,
  parseRelativePagasaTime,
  zParsedBulletin,
  type ParsedBulletin,
  type ParsedWindSignal,
} from '@bagyo/shared';
import {
  cleanText,
  parseBulletinNumber,
  parseCenter,
  parseIntensity,
  parseMovement,
  parseNameLine,
} from './common.js';
import { parseAreaList, type AreaParseIssue } from './areas.js';

export class BulletinParseError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'BulletinParseError';
  }
}

export interface HtmlParseResult {
  bulletins: ParsedBulletin[];
  issues: AreaParseIssue[];
}

/**
 * Parse PAGASA's severe-weather-bulletin page.
 * Returns zero bulletins for the "No Active Tropical Cyclone" state.
 * Throws BulletinParseError when the page looks like a bulletin but cannot be
 * parsed or fails schema validation (callers fall back to the PDF parser).
 */
export function parseBulletinHtml(html: string, sourceUrl = ''): HtmlParseResult {
  const $ = cheerio.load(html);

  const pageText = $('.article-content').text();
  if (
    /No Active Tropical Cyclone/i.test(pageText) ||
    /No Active Tropical Cyclone/i.test($.text())
  ) {
    return { bulletins: [], issues: [] };
  }

  const panes = $('div[role="tabpanel"]');
  if (panes.length === 0) {
    throw new BulletinParseError('no bulletin tab panels found', { sourceUrl });
  }

  const bulletins: ParsedBulletin[] = [];
  const issues: AreaParseIssue[] = [];

  panes.each((index, pane) => {
    const $pane = $(pane);
    const paneId = $pane.attr('id');

    // Bulletin number: the tab link's data-header ("Tropical Cyclone Bulletin #26"),
    // falling back to the page-level article header.
    const tabLink = paneId ? $(`a[href="#${paneId}"]`) : $();
    const headerText = tabLink.attr('data-header') ?? $('.article-header').first().text() ?? '';
    const num = parseBulletinNumber(headerText);
    if (!num) {
      throw new BulletinParseError('cannot extract bulletin number', { headerText });
    }

    const name = parseNameLine($pane.find('h3').first().text());
    if (!name) {
      throw new BulletinParseError('cannot parse cyclone designation', {
        h3: $pane.find('h3').first().text(),
      });
    }

    let issuedAt: string | null = null;
    let nextBulletinAt: string | null = null;
    $pane.find('h5').each((_, el) => {
      const t = cleanText($(el).text());
      if (!issuedAt && /Issued at/i.test(t)) issuedAt = parsePagasaDateTime(t);
    });
    if (!issuedAt) {
      throw new BulletinParseError('cannot parse issuance time', { paneId });
    }
    $pane.find('h5').each((_, el) => {
      const t = cleanText($(el).text());
      if (!nextBulletinAt && /next (advisory|bulletin)/i.test(t)) {
        nextBulletinAt = parseRelativePagasaTime(t, issuedAt as string);
      }
    });

    // Headline: the first all-caps-ish h5 that is not the issuance/validity line.
    let headline: string | null = null;
    $pane.find('h5').each((_, el) => {
      const t = cleanText($(el).text());
      if (headline || !t) return;
      if (/Issued at|next advisory|next bulletin|valid for broadcast/i.test(t)) return;
      if (t.length >= 15 && t === t.toUpperCase()) headline = t;
    });

    const panelBody = (heading: RegExp): string | null => {
      let found: string | null = null;
      $pane.find('.panel').each((_, el) => {
        if (found) return;
        const $el = $(el);
        const head = cleanText($el.find('.panel-heading').first().text());
        if (heading.test(head)) found = cleanText($el.find('.panel-body').first().text());
      });
      return found;
    };

    const centerText = panelBody(/location of (the )?(eye|center)/i);
    const center = centerText ? parseCenter(centerText) : null;
    const intensity = parseIntensity(panelBody(/strength|intensity/i) ?? '');
    const movement = parseMovement(panelBody(/movement/i) ?? '');

    const signals = parseHtmlSignals($, $pane, issues);

    const candidate: ParsedBulletin = {
      source: 'html',
      bulletinNumber: num.bulletinNumber,
      isFinal: num.isFinal,
      pagasaName: name.pagasaName,
      internationalName: name.internationalName,
      category: name.category,
      categoryRaw: name.categoryRaw,
      issuedAt,
      nextBulletinAt,
      headline,
      center,
      maxWindsKph: intensity.maxWindsKph,
      gustinessKph: intensity.gustinessKph,
      pressureHpa: intensity.pressureHpa,
      movementDirection: movement.direction,
      movementSpeedKph: movement.speedKph,
      signals,
    };

    const validated = zParsedBulletin.safeParse(candidate);
    if (!validated.success) {
      // A bulletin that parses but fails validation is a FAILED parse — never store garbage.
      throw new BulletinParseError('parsed bulletin failed schema validation', {
        index,
        issues: validated.error.issues,
      });
    }
    bulletins.push(validated.data);
  });

  return { bulletins, issues };
}

function parseHtmlSignals(
  $: cheerio.CheerioAPI,
  $pane: cheerio.Cheerio<AnyNode>,
  issues: AreaParseIssue[],
): ParsedWindSignal[] {
  const signals = new Map<number, ParsedWindSignal>();

  $pane.find('table').each((_, table) => {
    const $table = $(table);
    let currentLevel: number | null = null;

    $table.children('thead, tbody').each((_, block) => {
      const $block = $(block);
      if ($block.is('thead')) {
        currentLevel = null;
        const th = $block.find('th').first();
        const cls = th.attr('class') ?? '';
        const clsMatch = /signalno(\d)/i.exec(cls);
        const imgMatch = /tcws(\d)/i.exec($block.find('img').attr('src') ?? '');
        const textMatch = /Signal no\.?\s*(\d)/i.exec(cleanText(th.text()));
        const level = clsMatch?.[1] ?? imgMatch?.[1] ?? textMatch?.[1];
        if (level) currentLevel = Number(level);
        return;
      }
      if (currentLevel === null) return;
      const level = currentLevel;

      $block.children('tr').each((_, tr) => {
        const $tr = $(tr);
        const label = cleanText($tr.find('td').first().text());
        if (!/affected areas/i.test(label)) return;
        const $cell = $tr.find('td').eq(1);
        // Structure: ul > li(strong=island group) > ul > li(area sentence)
        $cell.find('ul > li').each((_, li) => {
          const $li = $(li);
          const groupLabel = cleanText($li.children('strong').first().text()).toLowerCase();
          if (!['luzon', 'visayas', 'mindanao'].includes(groupLabel)) return;
          const group = groupLabel as 'luzon' | 'visayas' | 'mindanao';
          $li.find('ul > li').each((_, inner) => {
            const sentence = cleanText($(inner).text());
            if (!sentence || sentence === '-') return;
            const parsed = parseAreaList(sentence, group);
            issues.push(...parsed.issues);
            const existing = signals.get(level) ?? { signalLevel: level, areas: [] };
            existing.areas.push(...parsed.areas);
            signals.set(level, existing);
          });
        });
      });
    });
  });

  return [...signals.values()].sort((a, b) => b.signalLevel - a.signalLevel);
}
