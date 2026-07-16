import { describe, expect, it } from 'vitest';
import type { ParsedBulletin } from '@bagyo/shared';
import { detectChanges, signalStateOf } from './change-detector.js';

function bulletin(overrides: Partial<ParsedBulletin> = {}): ParsedBulletin {
  return {
    source: 'html',
    bulletinNumber: 2,
    isFinal: false,
    pagasaName: 'INDAY',
    internationalName: 'BAVI',
    category: 'TY',
    categoryRaw: 'Typhoon',
    issuedAt: '2026-07-10T05:00:00+08:00',
    nextBulletinAt: null,
    headline: null,
    center: { lat: 20, lng: 127, description: null, outsidePar: false },
    maxWindsKph: 150,
    gustinessKph: 185,
    pressureHpa: 955,
    movementDirection: 'Northwestward',
    movementSpeedKph: 20,
    signals: [],
    ...overrides,
  };
}

function ctx(
  parsed: ParsedBulletin,
  previousAreas: Parameters<typeof detectChanges>[0]['previousAreas'] = [],
  isNewCyclone = false,
) {
  return {
    cyclone: { id: 'c1', pagasaName: 'INDAY', internationalName: 'BAVI', category: 'TY' },
    bulletin: { id: 'b1', bulletinNumber: parsed.bulletinNumber, issuedAt: parsed.issuedAt },
    previousAreas,
    isNewCyclone,
    parsed,
  };
}

const area = (psgc: string | null, name: string, level: number) => ({
  psgcCode: psgc,
  locationName: name,
  signalLevel: level,
});

describe('signalStateOf', () => {
  it('keeps the max level per area and keys unresolved areas by name', () => {
    const state = signalStateOf([
      area('X', 'Xprov', 1),
      area('X', 'Xprov', 3),
      area(null, 'Fuga Is.', 2),
    ]);
    expect(state.get('X')?.level).toBe(3);
    expect(state.get('name:fuga is.')?.level).toBe(2);
  });
});

describe('detectChanges', () => {
  it('always emits bulletin.issued', () => {
    const events = detectChanges(ctx(bulletin()));
    expect(events.map((e) => e.type)).toEqual(['bulletin.issued']);
  });

  it('emits cyclone.entered_par for a new cyclone inside PAR', () => {
    const events = detectChanges(ctx(bulletin(), [], true));
    expect(events.map((e) => e.type)).toContain('cyclone.entered_par');
  });

  it('does not emit entered_par for a new cyclone still outside PAR', () => {
    const parsed = bulletin({
      center: { lat: 16, lng: 136, description: null, outsidePar: true },
    });
    const events = detectChanges(ctx(parsed, [], true));
    expect(events.map((e) => e.type)).not.toContain('cyclone.entered_par');
  });

  it('emits cyclone.exited_par on a final bulletin outside PAR', () => {
    const parsed = bulletin({
      isFinal: true,
      center: { lat: 27, lng: 122, description: null, outsidePar: true },
    });
    const events = detectChanges(ctx(parsed));
    expect(events.map((e) => e.type)).toContain('cyclone.exited_par');
  });

  it('emits signal.raised for new and escalated areas', () => {
    const parsed = bulletin({
      signals: [
        {
          signalLevel: 2,
          areas: [
            {
              psgcCode: 'A',
              locationName: 'Aprov',
              locationType: 'PROVINCE',
              partialDescriptor: null,
              raw: 'Aprov',
              islandGroup: 'luzon',
            },
          ],
        },
        {
          signalLevel: 1,
          areas: [
            {
              psgcCode: 'B',
              locationName: 'Bprov',
              locationType: 'PROVINCE',
              partialDescriptor: null,
              raw: 'Bprov',
              islandGroup: 'luzon',
            },
          ],
        },
      ],
    });
    const events = detectChanges(ctx(parsed, [area('A', 'Aprov', 1)]));
    const raised = events.filter((e) => e.type === 'signal.raised');
    expect(raised).toHaveLength(2);
    expect(raised.find((e) => e.signal?.psgcCode === 'A')?.signal).toMatchObject({
      previousLevel: 1,
      newLevel: 2,
    });
    expect(raised.find((e) => e.signal?.psgcCode === 'B')?.signal).toMatchObject({
      previousLevel: null,
      newLevel: 1,
    });
  });

  it('emits signal.lowered for de-escalated and removed areas', () => {
    const parsed = bulletin({
      signals: [
        {
          signalLevel: 1,
          areas: [
            {
              psgcCode: 'A',
              locationName: 'Aprov',
              locationType: 'PROVINCE',
              partialDescriptor: null,
              raw: 'Aprov',
              islandGroup: 'luzon',
            },
          ],
        },
      ],
    });
    const events = detectChanges(ctx(parsed, [area('A', 'Aprov', 3), area('B', 'Bprov', 2)]));
    const lowered = events.filter((e) => e.type === 'signal.lowered');
    expect(lowered.find((e) => e.signal?.psgcCode === 'A')?.signal).toMatchObject({
      previousLevel: 3,
      newLevel: 1,
    });
    expect(lowered.find((e) => e.signal?.psgcCode === 'B')?.signal).toMatchObject({
      previousLevel: 2,
      newLevel: null,
    });
  });

  it('is quiet when the signal state is unchanged', () => {
    const parsed = bulletin({
      signals: [
        {
          signalLevel: 2,
          areas: [
            {
              psgcCode: 'A',
              locationName: 'Aprov',
              locationType: 'PROVINCE',
              partialDescriptor: null,
              raw: 'Aprov',
              islandGroup: 'luzon',
            },
          ],
        },
      ],
    });
    const events = detectChanges(ctx(parsed, [area('A', 'Aprov', 2)]));
    expect(events.map((e) => e.type)).toEqual(['bulletin.issued']);
  });
});
