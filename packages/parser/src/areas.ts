import {
  getMunicipality,
  getProvince,
  resolveLocation,
  type ParsedSignalArea,
} from '@bagyo/shared';
import { cleanText } from './common.js';

const DIRECTION_WORDS =
  '(?:extreme\\s+)?(?:north(?:ern)?|south(?:ern)?|east(?:ern)?|west(?:ern)?|central|' +
  'northeastern|northwestern|southeastern|southwestern)' +
  '(?:\\s+(?:and|&)\\s+(?:north(?:ern)?|south(?:ern)?|east(?:ern)?|west(?:ern)?|central|' +
  'northeastern|northwestern|southeastern|southwestern))?';

const PARTIAL_RE = new RegExp(
  `^(?:the\\s+)?(rest|${DIRECTION_WORDS})\\s+(?:portions?|half)?\\s*of\\s+(.+)$`,
  'i',
);

type IslandGroup = 'luzon' | 'visayas' | 'mindanao';

/**
 * Split a PAGASA area sentence into top-level segments: commas, " and ",
 * and " including " act as separators — but never inside parentheses.
 */
export function splitTopLevel(text: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = '';
  const pushCurrent = () => {
    const t = current.trim().replace(/^and\s+/i, '');
    if (t) segments.push(t);
    current = '';
  };
  const tokens = text.split(/(\(|\))/);
  for (const token of tokens) {
    if (token === '(') depth++;
    if (token === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && token !== '(' && token !== ')') {
      // Split this stretch on top-level separators.
      const parts = token.split(/,|\band\b|\bincluding\b/i);
      for (let i = 0; i < parts.length; i++) {
        current += parts[i] ?? '';
        if (i < parts.length - 1) pushCurrent();
      }
    } else {
      current += token;
    }
  }
  pushCurrent();
  return segments;
}

interface SegmentParts {
  partialDescriptor: string | null;
  name: string;
  children: string[];
}

export function dissectSegment(segment: string): SegmentParts {
  let body = cleanText(segment).replace(/\.$/, '');
  const children: string[] = [];
  const paren = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(body);
  if (paren?.[1] && paren[2] !== undefined) {
    body = paren[1].trim();
    for (const child of paren[2].split(',')) {
      const t = cleanText(child);
      if (t) children.push(t);
    }
  }
  let partialDescriptor: string | null = null;
  const partial = PARTIAL_RE.exec(body);
  if (partial?.[1] && partial[2]) {
    const word = partial[1]
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\s*&\s*/g, ' and ');
    partialDescriptor = word === 'rest' ? 'rest' : `${word} portion`;
    body = partial[2].trim();
  }
  body = body.replace(/^(?:the|of)\s+/i, '').trim();
  return { partialDescriptor, name: body, children };
}

function islandGroupFor(psgcCode: string | null, fallback: IslandGroup | null): IslandGroup | null {
  if (!psgcCode) return fallback;
  const province =
    getProvince(psgcCode) ??
    (() => {
      const mun = getMunicipality(psgcCode);
      return mun?.provinceCode ? getProvince(mun.provinceCode) : undefined;
    })();
  if (
    province &&
    (province.islandGroup === 'luzon' ||
      province.islandGroup === 'visayas' ||
      province.islandGroup === 'mindanao')
  ) {
    return province.islandGroup;
  }
  return fallback;
}

export interface AreaParseIssue {
  raw: string;
  reason: 'unresolved' | 'ambiguous';
}

export interface ParsedAreas {
  areas: ParsedSignalArea[];
  /** Names we could not resolve to PSGC — logged by callers, never fatal. */
  issues: AreaParseIssue[];
}

/**
 * Parse one wind-signal area sentence into structured areas.
 *
 * "Batanes, the eastern portion of Babuyan Islands (Babuyan Is., Didicas Is.)
 *  and the northeastern portion of mainland Cagayan (Santa Ana)"
 * yields the parent units (with partialDescriptor) plus one row per
 * enumerated child municipality/island.
 */
export function parseAreaList(text: string, islandGroup: IslandGroup | null = null): ParsedAreas {
  const areas: ParsedSignalArea[] = [];
  const issues: AreaParseIssue[] = [];
  // Protect direction conjunctions ("northern and eastern portions of…") from the
  // top-level "and" splitter by rewriting them with "&", which PARTIAL_RE accepts.
  const DIR = '(?:north|south|east|west)(?:ern)?|central|(?:north|south)(?:east|west)ern';
  const cleaned = cleanText(text).replace(
    new RegExp(`\\b(${DIR})\\s+and\\s+(${DIR})\\b`, 'gi'),
    '$1 & $2',
  );
  if (!cleaned || cleaned === '-') return { areas, issues };

  for (const segment of splitTopLevel(cleaned)) {
    const { partialDescriptor, name, children } = dissectSegment(segment);
    if (!name) continue;

    const parent = resolveLocation(name, { expect: 'any' });
    const parentGroup = islandGroupFor(parent.psgcCode, islandGroup);
    areas.push({
      psgcCode: parent.psgcCode,
      locationName: parent.name,
      locationType: parent.locationType,
      partialDescriptor,
      raw: segment.trim(),
      islandGroup: parentGroup,
    });
    if (parent.psgcCode === null && parent.locationType !== 'ISLAND') {
      issues.push({
        raw: segment.trim(),
        reason: parent.matchType === 'none' ? 'unresolved' : 'ambiguous',
      });
    }

    // Children enumerate the exact covered municipalities/islands within the parent.
    const provinceContext =
      parent.locationType === 'PROVINCE'
        ? (parent.psgcCode ?? undefined)
        : parent.psgcCode
          ? (getMunicipality(parent.psgcCode)?.provinceCode ?? undefined)
          : undefined;
    for (const child of children) {
      const resolved = resolveLocation(child, {
        provinceCode: provinceContext,
        expect: 'municipality',
      });
      areas.push({
        psgcCode: resolved.psgcCode,
        locationName: resolved.name,
        locationType: resolved.locationType,
        partialDescriptor: null,
        raw: `${child} (${name})`,
        islandGroup: islandGroupFor(resolved.psgcCode, parentGroup),
      });
      if (resolved.psgcCode === null && resolved.locationType !== 'ISLAND') {
        issues.push({ raw: child, reason: 'unresolved' });
      }
    }
  }
  return { areas, issues };
}
