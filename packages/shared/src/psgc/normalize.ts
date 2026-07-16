/**
 * Text normalization for matching PAGASA's free-text place names against PSGC names.
 * Handles PDF-extraction artifacts (stray spaces inside words, spaced hyphens),
 * diacritics (Peñablanca), and common Filipino toponym abbreviations.
 */

const ABBREVIATIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bsta\.?\s/g, 'santa '],
  [/\bsto\.?\s/g, 'santo '],
  [/\bgen\.?\s/g, 'general '],
  [/\bmt\.?\s/g, 'mount '],
];

export function normalizeName(input: string): string {
  let s = input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics: Peñablanca -> Penablanca
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s*-\s*/g, '-') // PDF artifact: "Licuan -Baay" -> "licuan-baay"
    .replace(/\s+/g, ' ')
    .trim();
  for (const [re, sub] of ABBREVIATIONS) s = s.replace(re, sub);
  // Unify city naming: "city of laoag" / "laoag city" both match "laoag" + cityness.
  s = s.replace(/^city of /, '').replace(/ city$/, '');
  return s.trim();
}

/** Space-free form, for PDF-mangled tokens like "M arinduque". */
export function squash(normalized: string): string {
  return normalized.replace(/[\s.'-]/g, '');
}

/** Damerau-free Levenshtein distance with early exit. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? max + 1;
}

export function fuzzyBudget(name: string): number {
  return name.length <= 5 ? 0 : name.length <= 9 ? 1 : 2;
}
