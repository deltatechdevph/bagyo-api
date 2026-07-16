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
import { BulletinParseError } from './html.js';

export interface PdfTextParseResult {
  bulletin: ParsedBulletin;
  issues: AreaParseIssue[];
}

/**
 * Parse the text layer of a PAGASA Tropical Cyclone Bulletin PDF.
 * `text` is the full extracted text; pages separated by \f are welcome but optional.
 * Throws BulletinParseError when required fields are missing or validation fails.
 */
export function parseBulletinPdfText(text: string, _sourceUrl = ''): PdfTextParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => cleanText(l))
    .filter((l) => l.length > 0);
  const full = lines.join('\n');
  const flat = cleanText(text);

  const numLine = lines.find((l) => /TROPICAL CYCLONE BULLETIN/i.test(l));
  const num = numLine ? parseBulletinNumber(numLine) : null;
  if (!num) throw new BulletinParseError('cannot extract bulletin number from PDF text');

  // The designation line directly follows the bulletin header.
  let name: ReturnType<typeof parseNameLine> = null;
  const headerIdx = lines.findIndex((l) => /TROPICAL CYCLONE BULLETIN/i.test(l));
  for (let i = headerIdx + 1; i < Math.min(headerIdx + 4, lines.length); i++) {
    name = parseNameLine(lines[i] ?? '');
    if (name) break;
  }
  if (!name) throw new BulletinParseError('cannot parse cyclone designation from PDF text');

  const issuedLine = lines.find((l) => /Issued at/i.test(l));
  const issuedAt = issuedLine ? parsePagasaDateTime(issuedLine) : null;
  if (!issuedAt) throw new BulletinParseError('cannot parse issuance time from PDF text');

  let nextBulletinAt: string | null = null;
  const nextLine = lines.find((l) => /next (tropical cyclone )?bulletin/i.test(l));
  if (nextLine) nextBulletinAt = parseRelativePagasaTime(nextLine, issuedAt);

  // Headline: first long all-caps line that is not boilerplate.
  const BOILERPLATE =
    /BULLETIN|PAGASA|DOST|DEPARTMENT OF SCIENCE|SERVICES ADMINISTRATION|WEATHER DIVISION|TRACK AND INTENSITY|WIND SIGNALS|HAZARDS|TROPICAL CYCLONE WIND|OUTLOOK|REPUBLIC OF/i;
  const headline =
    lines
      .find(
        (l) =>
          l.length >= 25 && l === l.toUpperCase() && /[A-Z]{4}/.test(l) && !BOILERPLATE.test(l),
      )
      ?.replace(/“\s+/g, '“')
      .replace(/\s+”/g, '”')
      .replace(/[“”]/g, '"') ?? null;

  const center = parseCenter(flat);
  const intensity = parseIntensity(flat);

  let movement: ReturnType<typeof parseMovement> = { direction: null, speedKph: null };
  const movementIdx = lines.findIndex((l) => /^Present Movement/i.test(l));
  if (movementIdx >= 0) {
    const inline = lines[movementIdx]?.replace(/^Present Movement:?\s*/i, '') ?? '';
    const source = inline.length > 0 ? inline : (lines[movementIdx + 1] ?? '');
    movement = parseMovement(source);
  }

  const { signals, issues } = parsePdfSignals(full);

  const candidate: ParsedBulletin = {
    source: 'pdf',
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
    throw new BulletinParseError('parsed PDF bulletin failed schema validation', {
      issues: validated.error.issues,
    });
  }
  return { bulletin: validated.data, issues };
}

/**
 * Extract the TCWS table from PDF text.
 *
 * The PDF table row mixes three visual columns; text extraction interleaves the
 * left label column ("2", "Wind threat:", "Gale-force", "winds") with the area
 * paragraph and the row-footer lines ("Warning lead time…", "Range of wind
 * speeds…", "Potential impacts…"). Each row reliably ENDS with the
 * "Potential impacts" line, so rows are chunked on that, label/footer lines are
 * dropped, and whatever remains is the area text.
 */
function parsePdfSignals(full: string): {
  signals: ParsedWindSignal[];
  issues: AreaParseIssue[];
} {
  const issues: AreaParseIssue[] = [];
  const start = full.search(/WIND SIGNALS?\s*\(TCWS\)\s*IN EFFECT/i);
  if (start === -1) return { signals: [], issues };
  let section = full.slice(start);
  const end = section.search(/OTHER HAZARDS|HAZARDS AFFECTING|TRACK AND INTENSITY FORECAST/i);
  if (end !== -1) section = section.slice(0, end);

  if (/No Wind Signal is currently hoisted/i.test(section)) {
    return { signals: [], issues };
  }

  const LABEL_LINE =
    /Warning lead time|Range of wind speeds|Potential impacts|^TCWS No\.|^WIND SIGNALS?|^\s*Luzon\s+Visayas\s+Mindanao\s*$|^Wind threat:?$|^(?:Strong|Gale-force|Storm-force|Typhoon-force|Extreme)(?:\s+to\s+(?:strong|gale-force|storm-force|typhoon-force))?(?:\s+winds?)?$|^winds?$/i;

  const signals: ParsedWindSignal[] = [];
  const chunks = section.split(/^.*Potential impacts of winds.*$/im);
  for (const chunk of chunks) {
    let level: number | null = null;
    const areaLines: string[] = [];
    for (const rawLine of chunk.split('\n')) {
      const line = cleanText(rawLine)
        // Trailing/leading empty-column dashes ("… of mainland - -").
        .replace(/(?:\s|^)-(?=\s|$)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!line) continue;
      const digit = /^([1-5])$/.exec(line);
      if (digit?.[1]) {
        level = Number(digit[1]);
        continue;
      }
      if (LABEL_LINE.test(line)) continue;
      areaLines.push(line);
    }
    const areaText = cleanText(areaLines.join(' '));
    if (!areaText) continue;
    if (level === null) {
      throw new BulletinParseError('TCWS row has area text but no signal level', { areaText });
    }
    const parsed = parseAreaList(areaText, null);
    issues.push(...parsed.issues);
    signals.push({ signalLevel: level, areas: parsed.areas });
  }
  return { signals: signals.sort((a, b) => b.signalLevel - a.signalLevel), issues };
}
