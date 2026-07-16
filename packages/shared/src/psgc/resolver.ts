import { PROVINCES } from './data/provinces.js';
import { MUNICIPALITIES } from './data/municipalities.js';
import { REGIONS } from './data/regions.js';
import type { PsgcMunicipality, PsgcProvince, ResolvedLocation } from './types.js';
import { editDistance, fuzzyBudget, normalizeName, squash } from './normalize.js';

export { PROVINCES, MUNICIPALITIES, REGIONS };

/**
 * PAGASA geographies that are not PSGC units, or that PAGASA names differently.
 * Values are either a PSGC code (administratively equivalent unit) or null
 * (a real geography we deliberately keep unresolved, e.g. individual islands).
 */
const ALIASES: ReadonlyMap<
  string,
  { code: string | null; type: ResolvedLocation['locationType'] }
> = new Map([
  // NCR — PAGASA always says "Metro Manila".
  ['metro manila', { code: '130000000', type: 'PROVINCE' }],
  ['national capital region', { code: '130000000', type: 'PROVINCE' }],
  ['ncr', { code: '130000000', type: 'PROVINCE' }],
  // "mainland Cagayan" distinguishes the province from the Babuyan Islands.
  ['mainland cagayan', { code: '021500000', type: 'PROVINCE' }],
  // The Babuyan Islands are administratively the municipality of Calayan, Cagayan.
  ['babuyan islands', { code: '021509000', type: 'MUNICIPALITY' }],
  // Island groups PAGASA addresses directly but PSGC has no single unit for.
  ['polillo islands', { code: null, type: 'ISLAND' }],
  ['calamian islands', { code: null, type: 'ISLAND' }],
  ['cuyo islands', { code: null, type: 'ISLAND' }],
  ['kalayaan islands', { code: null, type: 'ISLAND' }],
  ['babuyan is', { code: null, type: 'ISLAND' }],
  ['camiguin is', { code: null, type: 'ISLAND' }],
  ['didicas is', { code: null, type: 'ISLAND' }],
  ['fuga is', { code: null, type: 'ISLAND' }],
  ['calayan is', { code: null, type: 'ISLAND' }],
  ['dalupiri is', { code: null, type: 'ISLAND' }],
  ['lubang island', { code: null, type: 'ISLAND' }],
  ['burias island', { code: null, type: 'ISLAND' }],
  ['ticao island', { code: null, type: 'ISLAND' }],
  ['batan island', { code: null, type: 'ISLAND' }],
  ['itbayat island', { code: null, type: 'ISLAND' }],
  // Historic/alternate spellings PAGASA still uses.
  ['western samar', { code: '086000000', type: 'PROVINCE' }],
  ['compostela valley', { code: '118200000', type: 'PROVINCE' }],
  ['north cotabato', { code: '124700000', type: 'PROVINCE' }],
]);

interface Indexed<T> {
  byName: Map<string, T[]>;
  bySquash: Map<string, T[]>;
}

function buildIndex<T extends { name: string }>(items: readonly T[]): Indexed<T> {
  const byName = new Map<string, T[]>();
  const bySquash = new Map<string, T[]>();
  for (const item of items) {
    const n = normalizeName(item.name);
    const s = squash(n);
    (byName.get(n) ?? byName.set(n, []).get(n))?.push(item);
    (bySquash.get(s) ?? bySquash.set(s, []).get(s))?.push(item);
  }
  return { byName, bySquash };
}

const provinceIndex = buildIndex(PROVINCES);
const municipalityIndex = buildIndex(MUNICIPALITIES);
const municipalitiesByProvince = new Map<string, PsgcMunicipality[]>();
for (const m of MUNICIPALITIES) {
  if (!m.provinceCode) continue;
  let list = municipalitiesByProvince.get(m.provinceCode);
  if (!list) {
    list = [];
    municipalitiesByProvince.set(m.provinceCode, list);
  }
  list.push(m);
}
const provinceByCode = new Map(PROVINCES.map((p) => [p.code, p]));
const municipalityByCode = new Map(MUNICIPALITIES.map((m) => [m.code, m]));

export function getProvince(code: string): PsgcProvince | undefined {
  return provinceByCode.get(code);
}
export function getMunicipality(code: string): PsgcMunicipality | undefined {
  return municipalityByCode.get(code);
}
export function municipalitiesOf(provinceCode: string): readonly PsgcMunicipality[] {
  return municipalitiesByProvince.get(provinceCode) ?? [];
}

function munType(m: PsgcMunicipality): 'CITY' | 'MUNICIPALITY' {
  return m.type;
}

/** True when the name is a bare island reference ("Fuga Is.", "Babuyan Is.") */
function isIslandReference(cleaned: string): boolean {
  return /\b(is|isl|island|islands)\.?$/i.test(cleaned) && !/^city of/i.test(cleaned);
}

export interface ResolveOptions {
  /** Restrict municipality matching to this province (PSGC code). */
  provinceCode?: string;
  /** What kind of unit the caller expects; 'any' tries province first, then municipality. */
  expect?: 'province' | 'municipality' | 'any';
}

/**
 * Resolve a free-text PAGASA place name to a PSGC unit.
 * Never throws: unresolvable names return psgcCode null with the cleaned name preserved.
 */
export function resolveLocation(rawName: string, opts: ResolveOptions = {}): ResolvedLocation {
  const expect = opts.expect ?? 'any';
  const cleaned = rawName
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,;]+$/, '');
  if (cleaned.length === 0) {
    return { psgcCode: null, name: rawName.trim(), locationType: 'UNKNOWN', matchType: 'none' };
  }
  const norm = normalizeName(cleaned);

  const alias = ALIASES.get(norm) ?? ALIASES.get(norm.replace(/\.$/, ''));
  if (alias) {
    if (alias.code === null) {
      return { psgcCode: null, name: cleaned, locationType: alias.type, matchType: 'alias' };
    }
    const unit =
      alias.type === 'PROVINCE'
        ? provinceByCode.get(alias.code)
        : municipalityByCode.get(alias.code);
    return {
      psgcCode: alias.code,
      name: unit?.name ?? cleaned,
      locationType:
        alias.type === 'PROVINCE'
          ? 'PROVINCE'
          : unit && 'type' in unit
            ? munType(unit)
            : alias.type,
      matchType: 'alias',
    };
  }

  const munFilter = opts.provinceCode
    ? (m: PsgcMunicipality) => m.provinceCode === opts.provinceCode
    : undefined;

  // Exact matches first — real LGUs like "Dinagat Islands" (a province) must win
  // over the bare-island heuristic below.
  for (const mode of ['exact', 'fuzzy'] as const) {
    // The island heuristic sits between exact and fuzzy passes: "Camiguin Is." in
    // the Babuyans must not fuzzy-match Camiguin province in Mindanao.
    if (mode === 'fuzzy' && isIslandReference(cleaned)) {
      return { psgcCode: null, name: cleaned, locationType: 'ISLAND', matchType: 'none' };
    }
    if (expect !== 'municipality') {
      const hit = matchIn(provinceIndex, norm, undefined, mode);
      if (hit.length === 1 && hit[0]) {
        const p = hit[0].item;
        return { psgcCode: p.code, name: p.name, locationType: 'PROVINCE', matchType: hit[0].how };
      }
    }
    if (expect !== 'province') {
      const hits = matchIn(municipalityIndex, norm, munFilter, mode);
      if (hits.length === 1 && hits[0]) {
        const m = hits[0].item;
        return { psgcCode: m.code, name: m.name, locationType: munType(m), matchType: hits[0].how };
      }
      // Ambiguous nationally ("Santa Ana" exists in Cagayan and Pampanga): give up
      // rather than guess — callers should pass provinceCode context when they have it.
    }
  }

  return { psgcCode: null, name: cleaned, locationType: 'UNKNOWN', matchType: 'none' };
}

interface Match<T> {
  item: T;
  how: 'exact' | 'fuzzy';
}

function matchIn<T extends { name: string }>(
  index: Indexed<T>,
  norm: string,
  filter: ((item: T) => boolean) | undefined,
  mode: 'exact' | 'fuzzy',
): Match<T>[] {
  const apply = (items: T[] | undefined): T[] =>
    (items ?? []).filter((i) => (filter ? filter(i) : true));

  if (mode === 'exact') {
    const exact = apply(index.byName.get(norm));
    if (exact.length > 0) return dedupe(exact).map((item) => ({ item, how: 'exact' as const }));
    const squashed = apply(index.bySquash.get(squash(norm)));
    return dedupe(squashed).map((item) => ({ item, how: 'exact' as const }));
  }

  const budget = fuzzyBudget(norm);
  if (budget === 0) return [];
  const out: T[] = [];
  for (const [candidate, items] of index.byName) {
    if (editDistance(norm, candidate, budget) <= budget) {
      out.push(...apply(items));
    }
  }
  return dedupe(out).map((item) => ({ item, how: 'fuzzy' as const }));
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
