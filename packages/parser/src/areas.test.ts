import { describe, expect, it } from 'vitest';
import { dissectSegment, parseAreaList, splitTopLevel } from './areas.js';

describe('splitTopLevel', () => {
  it('splits on commas and "and" outside parentheses only', () => {
    expect(
      splitTopLevel(
        'Batanes, the eastern portion of Babuyan Islands (Babuyan Is., Didicas Is.) and Isabela',
      ),
    ).toEqual([
      'Batanes',
      'the eastern portion of Babuyan Islands (Babuyan Is., Didicas Is.)',
      'Isabela',
    ]);
  });

  it('treats "including" as a separator', () => {
    expect(
      splitTopLevel(
        'the northeastern portion of Cagayan (Gonzaga) including the eastern portion of Babuyan Islands (Babuyan Is.)',
      ),
    ).toEqual([
      'the northeastern portion of Cagayan (Gonzaga)',
      'the eastern portion of Babuyan Islands (Babuyan Is.)',
    ]);
  });

  it('ignores unbalanced closing parens gracefully', () => {
    expect(splitTopLevel('Aurora), Quezon')).toEqual(['Aurora)', 'Quezon']);
  });
});

describe('dissectSegment', () => {
  it('extracts partial descriptor and children', () => {
    expect(dissectSegment('the northern portion of Abra (Tineg, Lagayan)')).toEqual({
      partialDescriptor: 'northern portion',
      name: 'Abra',
      children: ['Tineg', 'Lagayan'],
    });
  });

  it('handles "the rest of"', () => {
    expect(dissectSegment('The rest of Babuyan Islands')).toEqual({
      partialDescriptor: 'rest',
      name: 'Babuyan Islands',
      children: [],
    });
  });

  it('handles compound directions', () => {
    expect(dissectSegment('the northern & central portions of Cagayan')).toEqual({
      partialDescriptor: 'northern and central portion',
      name: 'Cagayan',
      children: [],
    });
  });

  it('handles extreme + direction', () => {
    expect(dissectSegment('the extreme northern portion of Isabela')).toEqual({
      partialDescriptor: 'extreme northern portion',
      name: 'Isabela',
      children: [],
    });
  });

  it('passes plain names through', () => {
    expect(dissectSegment('Metro Manila')).toEqual({
      partialDescriptor: null,
      name: 'Metro Manila',
      children: [],
    });
  });
});

describe('parseAreaList', () => {
  it('emits parent + child rows with PSGC resolution', () => {
    const { areas, issues } = parseAreaList(
      'the northern portion of Ilocos Norte (Pagudpud, Adams)',
      'luzon',
    );
    expect(issues).toEqual([]);
    expect(areas).toHaveLength(3);
    expect(areas[0]).toMatchObject({
      psgcCode: '012800000',
      locationType: 'PROVINCE',
      partialDescriptor: 'northern portion',
    });
    expect(areas[1]).toMatchObject({ locationName: 'Pagudpud', partialDescriptor: null });
    expect(areas[2]).toMatchObject({ locationName: 'Adams', locationType: 'MUNICIPALITY' });
  });

  it('preserves compound directions across the "and" splitter', () => {
    const { areas } = parseAreaList('the northern and eastern portions of Samar');
    expect(areas).toHaveLength(1);
    expect(areas[0]).toMatchObject({
      partialDescriptor: 'northern and eastern portion',
      locationName: 'Samar',
    });
  });

  it('repairs PDF artifacts (spaces before punctuation, trailing comma in parens)', () => {
    const { areas, issues } = parseAreaList(
      'the eastern portion of Babuyan Islands (Babuyan Is ., Didicas Is., Camiguin Is.,)',
    );
    expect(issues).toEqual([]);
    expect(areas.map((a) => a.locationName)).toEqual([
      'Calayan',
      'Babuyan Is.',
      'Didicas Is.',
      'Camiguin Is.',
    ]);
    expect(areas.every((a, i) => (i === 0 ? a.psgcCode !== null : a.psgcCode === null))).toBe(true);
  });

  it('resolves ambiguous municipalities using the parent province', () => {
    const { areas } = parseAreaList('the northeastern portion of mainland Cagayan (Santa Ana)');
    const child = areas.find((a) => a.locationName === 'Santa Ana');
    expect(child?.psgcCode).toBe('021523000');
  });

  it('reports unresolvable names as issues without crashing', () => {
    const { areas, issues } = parseAreaList('the western portion of Narnia (Lantern Waste)');
    expect(areas).toHaveLength(2);
    expect(areas[0]).toMatchObject({ psgcCode: null, locationType: 'UNKNOWN' });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ reason: 'unresolved' });
  });

  it('returns nothing for empty or dash-only cells', () => {
    expect(parseAreaList('-').areas).toEqual([]);
    expect(parseAreaList('  ').areas).toEqual([]);
  });

  it('assigns island group from resolved geography, falling back to the given column', () => {
    const { areas } = parseAreaList('Northern Samar', 'visayas');
    expect(areas[0]).toMatchObject({ locationName: 'Northern Samar', islandGroup: 'visayas' });
    const mixed = parseAreaList('Dinagat Islands', 'visayas');
    // Dinagat is administratively Mindanao (Caraga) even if listed under Visayas.
    expect(mixed.areas[0]?.islandGroup).toBe('mindanao');
  });
});
