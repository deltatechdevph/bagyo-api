import type { CycloneCategory } from '@bagyo/shared';

/** Collapse whitespace and repair frequent PDF-extraction artifacts. */
export function cleanText(input: string): string {
  return input
    .replace(/[\u00a0\u2007\u202f]/g, ' ') // NBSP variants
    .replace(/\s+([.,)])/g, '$1') // "Babuyan Is ." -> "Babuyan Is."
    .replace(/\(\s+/g, '(')
    .replace(/,\s*\)/g, ')') // "(…Camiguin Is.,)" -> "(…Camiguin Is.)"
    .replace(/\s+/g, ' ')
    .trim();
}

const CATEGORY_PREFIXES: ReadonlyArray<[string, CycloneCategory]> = [
  ['super typhoon', 'STY'],
  ['severe tropical storm', 'STS'],
  ['tropical storm', 'TS'],
  ['tropical depression', 'TD'],
  ['typhoon', 'TY'],
];

export interface ParsedNameLine {
  categoryRaw: string;
  category: CycloneCategory | null;
  pagasaName: string;
  internationalName: string | null;
  /** True for "Low Pressure Area (formerly INDAY)" style post-cyclone bulletins. */
  isFormer: boolean;
}

const QUOTE = /["“”'']/g;

/**
 * Parse the cyclone designation line:
 *   PDF:  `Typhoon INDAY (BAVI)`, `Low Pressure Area (formerly "JOSIE")`
 *   HTML: `Super Typhoon "Nando"`
 */
export function parseNameLine(rawLine: string): ParsedNameLine | null {
  const line = cleanText(rawLine).replace(QUOTE, '"');
  if (line.length === 0) return null;

  const formerly = /^(.*?)\s*\(\s*formerly\s+"?([A-Za-zÑñ-]+)"?\s*\)/i.exec(line);
  if (formerly?.[1] && formerly[2]) {
    return {
      categoryRaw: formerly[1].trim(),
      category: null,
      pagasaName: formerly[2].toUpperCase(),
      internationalName: null,
      isFormer: true,
    };
  }

  const lower = line.toLowerCase();
  for (const [prefix, category] of CATEGORY_PREFIXES) {
    if (!lower.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length).trim();
    const m = /^"?([A-Za-zÑñ-]+)"?(?:\s*\(([A-Za-z-]+)\))?/.exec(rest);
    if (!m?.[1]) return null;
    return {
      categoryRaw: line.slice(0, prefix.length).trim(),
      category,
      pagasaName: m[1].toUpperCase(),
      internationalName: m[2] ? m[2].toUpperCase() : null,
      isFormer: false,
    };
  }
  return null;
}

export interface ParsedCenter {
  lat: number;
  lng: number;
  description: string | null;
  outsidePar: boolean;
}

/**
 * Parse a center-position sentence, e.g.
 * "…estimated based on all available data at 620 km East of Basco, Batanes (20.3°N, 127.9°E)"
 * Tolerates PDF quirks: "(19.5 °N, 120.1 °E )", missing degree sign ("134.6E").
 */
export function parseCenter(rawText: string): ParsedCenter | null {
  const text = cleanText(rawText);
  const coords =
    /\(\s*(\d{1,2}(?:\.\d+)?)\s*°?\s*N\s*,?\s*(\d{1,3}(?:\.\d+)?)\s*°?\s*E?\s*\)/i.exec(text);
  if (!coords?.[1] || !coords[2]) return null;
  const lat = Number(coords[1]);
  const lng = Number(coords[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  let description: string | null = null;
  const before = text.slice(0, coords.index).replace(/\s*\(OUTSIDE(?: THE)? PAR\)\s*/gi, ' ');
  const desc = /\bat\s+(\d[\d,]*\s*km\s+[^()]*?)\s*$/i.exec(before);
  if (desc?.[1]) {
    description = desc[1].trim() || null;
  } else {
    // "…in the vicinity of X" or other free-form descriptions.
    const alt = /\b(?:at|in)\s+(the vicinity of [^()]+?)\s*$/i.exec(before);
    description = alt?.[1] ? alt[1].trim() : null;
  }

  return { lat, lng, description, outsidePar: /OUTSIDE(?: THE)? PAR/i.test(text) };
}

export interface ParsedIntensity {
  maxWindsKph: number | null;
  gustinessKph: number | null;
  pressureHpa: number | null;
}

export function parseIntensity(rawText: string): ParsedIntensity {
  const text = cleanText(rawText);
  const num = (re: RegExp): number | null => {
    const m = re.exec(text);
    return m?.[1] ? Number(m[1].replace(/,/g, '')) : null;
  };
  return {
    maxWindsKph: num(/maximum sustained winds of\s+([\d,]+)\s*km\/?h/i),
    gustinessKph: num(/gustiness of up to\s+([\d,]+)\s*km\/?h/i),
    pressureHpa: num(/central pressure of\s+([\d,.]+)\s*hPa/i),
  };
}

export interface ParsedMovement {
  direction: string | null;
  speedKph: number | null;
}

/**
 * "Moving Westward at 20 km/h" | "Northwestward at 20 km/h" |
 * "North northeastward Slowly" | "Almost stationary"
 */
export function parseMovement(rawText: string): ParsedMovement {
  const text = cleanText(rawText).replace(/^moving\s+/i, '');
  if (text.length === 0) return { direction: null, speedKph: null };
  const withSpeed = /^(.+?)\s+at\s+([\d,]+)\s*km\/?h/i.exec(text);
  if (withSpeed?.[1] && withSpeed[2]) {
    return { direction: withSpeed[1].trim(), speedKph: Number(withSpeed[2].replace(/,/g, '')) };
  }
  if (/stationary/i.test(text)) return { direction: 'Almost stationary', speedKph: 0 };
  const slowly = /^(.+?)\s+slowly\b/i.exec(text);
  if (slowly?.[1]) return { direction: slowly[1].trim(), speedKph: null };
  return { direction: text, speedKph: null };
}

export interface ParsedBulletinNumber {
  bulletinNumber: number;
  isFinal: boolean;
}

/** "TROPICAL CYCLONE BULLETIN NR. 16F" / "Tropical Cyclone Bulletin #26" */
export function parseBulletinNumber(rawText: string): ParsedBulletinNumber | null {
  const m = /BULLETIN\s*(?:NR\.?|NO\.?|#)?\s*(\d+)\s*[-–]?\s*(F\b|FINAL)?/i.exec(
    cleanText(rawText),
  );
  if (!m?.[1]) return null;
  return { bulletinNumber: Number(m[1]), isFinal: Boolean(m[2]) };
}
