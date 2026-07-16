import { describe, expect, it } from 'vitest';
import { resolveLocation, PROVINCES, MUNICIPALITIES, municipalitiesOf } from './resolver.js';
import { normalizeName, squash, editDistance } from './normalize.js';

describe('dataset integrity', () => {
  it('bundles all 81 provinces + Metro Manila pseudo-province', () => {
    expect(PROVINCES).toHaveLength(82);
  });

  it('bundles 1,634 cities/municipalities linked to provinces (except the two independent cities)', () => {
    expect(MUNICIPALITIES).toHaveLength(1634);
    const orphans = MUNICIPALITIES.filter((m) => !m.provinceCode).map((m) => m.name);
    // Isabela City (Basilan) and Cotabato City are administratively province-independent.
    expect(orphans.sort()).toEqual(['City of Cotabato', 'City of Isabela']);
  });

  it('lists municipalities of a province', () => {
    const cagayan = municipalitiesOf('021500000').map((m) => m.name);
    expect(cagayan).toContain('Calayan');
    expect(cagayan).toContain('Santa Ana');
  });
});

describe('normalizeName', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalizeName('Peñablanca')).toBe('penablanca');
    expect(normalizeName('Las Piñas')).toBe('las pinas');
  });

  it('repairs PDF hyphen spacing', () => {
    expect(normalizeName('Licuan -Baay')).toBe('licuan-baay');
  });

  it('expands common abbreviations', () => {
    expect(normalizeName('Sta. Ana')).toBe('santa ana');
    expect(normalizeName('Gen. Nakar')).toBe('general nakar');
  });

  it('unifies city naming', () => {
    expect(normalizeName('City of Laoag')).toBe('laoag');
    expect(normalizeName('Laoag City')).toBe('laoag');
  });

  it('squash removes separators for PDF-mangled tokens', () => {
    expect(squash(normalizeName('M arinduque'))).toBe('marinduque');
  });

  it('editDistance early-exits beyond the budget', () => {
    expect(editDistance('abra', 'aurora', 1)).toBeGreaterThan(1);
    expect(editDistance('ilocos norte', 'ilocos norte', 2)).toBe(0);
    expect(editDistance('batanes', 'batanas', 2)).toBe(1);
  });
});

describe('resolveLocation — provinces', () => {
  it('resolves exact province names', () => {
    const r = resolveLocation('Ilocos Norte');
    expect(r).toMatchObject({
      psgcCode: '012800000',
      locationType: 'PROVINCE',
      matchType: 'exact',
    });
  });

  it('resolves provinces case-insensitively with noise', () => {
    const r = resolveLocation('  BATANES ');
    expect(r.psgcCode).toBe('020900000');
    expect(r.name).toBe('Batanes');
  });

  it('resolves Metro Manila to the NCR pseudo-province', () => {
    const r = resolveLocation('Metro Manila');
    expect(r).toMatchObject({
      psgcCode: '130000000',
      locationType: 'PROVINCE',
      matchType: 'alias',
    });
  });

  it('resolves "mainland Cagayan" to Cagayan province', () => {
    expect(resolveLocation('mainland Cagayan').psgcCode).toBe('021500000');
  });

  it('resolves PAGASA spelling variants via alias', () => {
    expect(resolveLocation('Western Samar').psgcCode).toBe('086000000');
    expect(resolveLocation('Compostela Valley').psgcCode).toBe('118200000');
  });

  it('survives PDF-mangled interior spaces', () => {
    expect(resolveLocation('M arinduque').psgcCode).toBe('174000000');
  });
});

describe('resolveLocation — municipalities', () => {
  it('resolves a unique municipality nationally', () => {
    const r = resolveLocation('Pagudpud');
    expect(r.locationType).toBe('MUNICIPALITY');
    expect(r.psgcCode).toBe('012815000');
  });

  it('refuses ambiguous names without province context', () => {
    const r = resolveLocation('Santa Ana');
    expect(r.psgcCode).toBeNull();
    expect(r.matchType).toBe('none');
  });

  it('disambiguates with province context', () => {
    const r = resolveLocation('Santa Ana', { provinceCode: '021500000' });
    expect(r.psgcCode).toBe('021523000');
    expect(r.locationType).toBe('MUNICIPALITY');
  });

  it('resolves cities in both PSGC naming styles', () => {
    expect(resolveLocation('Laoag City').locationType).toBe('CITY');
    expect(resolveLocation('Tuguegarao City').locationType).toBe('CITY');
  });

  it('applies fuzzy matching within budget', () => {
    const r = resolveLocation('Pagudpod', { provinceCode: '012800000' }); // one-letter typo
    expect(r.psgcCode).toBe('012815000');
    expect(r.matchType).toBe('fuzzy');
  });
});

describe('resolveLocation — islands and unresolvables', () => {
  it('maps Babuyan Islands to Calayan municipality', () => {
    const r = resolveLocation('Babuyan Islands');
    expect(r).toMatchObject({ psgcCode: '021509000', matchType: 'alias' });
  });

  it('keeps bare island references unresolved (Camiguin Is. must NOT hit Camiguin province)', () => {
    const r = resolveLocation('Camiguin Is.');
    expect(r.psgcCode).toBeNull();
    expect(r.locationType).toBe('ISLAND');
  });

  it('keeps island groups unresolved but typed', () => {
    const r = resolveLocation('Polillo Islands');
    expect(r).toMatchObject({ psgcCode: null, locationType: 'ISLAND', matchType: 'alias' });
  });

  it('never throws on garbage — preserves the raw name', () => {
    const r = resolveLocation('Atlantis Prime');
    expect(r).toMatchObject({ psgcCode: null, locationType: 'UNKNOWN', matchType: 'none' });
    expect(r.name).toBe('Atlantis Prime');
  });

  it('handles empty input', () => {
    expect(resolveLocation('   ').psgcCode).toBeNull();
  });
});
