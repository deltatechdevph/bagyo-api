import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBulletinHtml } from './html.js';
import { parseBulletinPdf } from './pdf.js';

const FIX = join(import.meta.dirname, '../../../fixtures');
const pdf = (name: string) => new Uint8Array(readFileSync(join(FIX, 'pdf', name)));
const html = (name: string) => readFileSync(join(FIX, 'html', name), 'utf-8');

describe('real PDF bulletins', () => {
  it('TCB #10 INDAY — typhoon with Signals 1–2, nested municipality lists', async () => {
    const { bulletin: b, issues } = await parseBulletinPdf(pdf('TCB_10_inday.pdf'));
    expect(issues).toEqual([]);
    expect(b).toMatchObject({
      source: 'pdf',
      bulletinNumber: 10,
      isFinal: false,
      pagasaName: 'INDAY',
      internationalName: 'BAVI',
      category: 'TY',
      issuedAt: '2026-07-10T05:00:00+08:00',
      nextBulletinAt: '2026-07-10T11:00:00+08:00',
      maxWindsKph: 150,
      gustinessKph: 185,
      pressureHpa: 955,
      movementDirection: 'Northwestward',
      movementSpeedKph: 20,
    });
    expect(b.center).toEqual({
      lat: 20.3,
      lng: 127.9,
      description: '620 km East of Basco, Batanes',
      outsidePar: true,
    });
    expect(b.headline).toBe(
      '"INDAY" WEAKENS FURTHER AS IT ACCELERATES NORTHWESTWARD OVER THE SEA EAST OF BATANES.',
    );

    expect(b.signals.map((s) => s.signalLevel)).toEqual([2, 1]);
    const s2 = b.signals[0]!;
    expect(s2.areas).toHaveLength(7);
    expect(s2.areas[0]).toMatchObject({
      psgcCode: '020900000',
      locationName: 'Batanes',
      locationType: 'PROVINCE',
      partialDescriptor: null,
    });
    // "the eastern portion of Babuyan Islands (…)" — alias to Calayan municipality.
    expect(s2.areas[1]).toMatchObject({
      psgcCode: '021509000',
      locationName: 'Calayan',
      partialDescriptor: 'eastern portion',
    });
    // "Camiguin Is." must stay an island — NOT Camiguin province in Mindanao.
    const camiguin = s2.areas.find((a) => a.locationName === 'Camiguin Is.');
    expect(camiguin).toMatchObject({
      psgcCode: null,
      locationType: 'ISLAND',
      islandGroup: 'luzon',
    });
    // "the northeastern portion of mainland Cagayan (Santa Ana)" — context disambiguation.
    const santaAna = s2.areas.find((a) => a.locationName === 'Santa Ana');
    expect(santaAna).toMatchObject({ psgcCode: '021523000', locationType: 'MUNICIPALITY' });

    const s1 = b.signals[1]!;
    expect(s1.areas.length).toBe(24);
    const abra = s1.areas.find((a) => a.locationName === 'Abra');
    expect(abra).toMatchObject({ partialDescriptor: 'northern portion' });
    // PDF artifact "Licuan -Baay" resolves to the real municipality.
    const licuan = s1.areas.find((a) => a.locationName === 'Licuan-Baay');
    expect(licuan?.psgcCode).toBeTruthy();
    const rests = s1.areas.filter((a) => a.partialDescriptor === 'rest');
    expect(rests.map((a) => a.locationName).sort()).toEqual(['Cagayan', 'Calayan']);
  });

  it('TCB #12 FRANCISCO — "including" phrasing joins segments', async () => {
    const { bulletin: b, issues } = await parseBulletinPdf(pdf('TCB_12_francisco.pdf'));
    expect(issues).toEqual([]);
    expect(b).toMatchObject({
      bulletinNumber: 12,
      pagasaName: 'FRANCISCO',
      internationalName: 'MEKKHALA',
      category: 'TY',
      maxWindsKph: 175,
      pressureHpa: 940,
    });
    expect(b.signals).toHaveLength(1);
    const areas = b.signals[0]!.areas;
    expect(areas.map((a) => a.locationName)).toContain('Batanes');
    expect(areas.map((a) => a.locationName)).toContain('Calayan'); // Babuyan Islands alias
    expect(areas.find((a) => a.locationName === 'Gonzaga')).toMatchObject({
      locationType: 'MUNICIPALITY',
    });
  });

  it('TCB #16F INDAY — final bulletin, outside PAR, no signals', async () => {
    const { bulletin: b } = await parseBulletinPdf(pdf('TCB_16_inday.pdf'));
    expect(b).toMatchObject({
      bulletinNumber: 16,
      isFinal: true,
      nextBulletinAt: null,
      signals: [],
    });
    expect(b.center?.outsidePar).toBe(true);
  });

  it('TCB #1 FRANCISCO — STS, "No Wind Signal is currently hoisted"', async () => {
    const { bulletin: b } = await parseBulletinPdf(pdf('TCB_1_francisco.pdf'));
    expect(b).toMatchObject({
      bulletinNumber: 1,
      isFinal: false,
      category: 'STS',
      categoryRaw: 'Severe Tropical Storm',
      signals: [],
      pressureHpa: 990,
    });
    // "1,295 km" — thousands separator in distances must not break parsing.
    expect(b.center?.description).toBe('1,295 km East of Southeastern Luzon');
  });

  it('TCB #1 INDAY — super typhoon named while outside PAR', async () => {
    const { bulletin: b, issues } = await parseBulletinPdf(pdf('TCB_1_inday.pdf'));
    expect(issues).toEqual([]);
    expect(b).toMatchObject({
      bulletinNumber: 1,
      category: 'STY',
      categoryRaw: 'Super Typhoon',
      maxWindsKph: 185,
      pressureHpa: 930,
    });
    expect(b.center?.outsidePar).toBe(true);
    // Signal 1 over "(Santa Ana, Gonzaga, Lal-Lo, Gattaran, Santa Teresita)".
    const s1 = b.signals[0]!;
    expect(s1.signalLevel).toBe(1);
    expect(s1.areas.find((a) => a.locationName === 'Lal-Lo')?.psgcCode).toBeTruthy();
  });

  it('TCB #3F JOSIE — LPA (formerly), null category, pressure-only intensity', async () => {
    const { bulletin: b } = await parseBulletinPdf(pdf('TCB_3_josie.pdf'));
    expect(b).toMatchObject({
      bulletinNumber: 3,
      isFinal: true,
      pagasaName: 'JOSIE',
      internationalName: null,
      category: null,
      categoryRaw: 'Low Pressure Area',
      maxWindsKph: null,
      gustinessKph: null,
      pressureHpa: 1008,
      movementDirection: 'North northeastward',
      movementSpeedKph: null,
      signals: [],
    });
    // Coordinate quirk: "(14.5°N, 134.6E)" — missing degree symbol on longitude.
    expect(b.center).toMatchObject({ lat: 14.5, lng: 134.6 });
  });
});

describe('real HTML pages', () => {
  it('returns no bulletins for the "No Active Tropical Cyclone" state', () => {
    const r = parseBulletinHtml(html('swb-no-active.html'));
    expect(r.bulletins).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('Super Typhoon NANDO — Signals 1–4 from the real TCWS table markup', () => {
    const { bulletins, issues } = parseBulletinHtml(html('swb-active-nando.html'));
    expect(bulletins).toHaveLength(1);
    const b = bulletins[0]!;
    expect(b).toMatchObject({
      source: 'html',
      bulletinNumber: 26,
      pagasaName: 'NANDO',
      internationalName: null, // HTML page omits international names
      category: 'STY',
      issuedAt: '2025-09-22T23:00:00+08:00',
      nextBulletinAt: '2025-09-23T05:00:00+08:00',
      maxWindsKph: 205,
      gustinessKph: 285,
      pressureHpa: null,
      movementDirection: 'Westward',
      movementSpeedKph: 20,
    });
    expect(b.center).toMatchObject({ lat: 19.5, lng: 120.1, outsidePar: false });
    expect(b.signals.map((s) => s.signalLevel)).toEqual([4, 3, 2, 1]);

    const s4 = b.signals[0]!;
    expect(s4.areas.find((a) => a.locationName === 'Pagudpud')).toMatchObject({
      psgcCode: '012815000',
      locationType: 'MUNICIPALITY',
      islandGroup: 'luzon',
    });
    expect(s4.areas.find((a) => a.locationName === 'Ilocos Norte')).toMatchObject({
      partialDescriptor: 'northern portion',
    });
    // Only the deliberately-unresolved island group shows up as a non-issue:
    expect(issues).toEqual([]);
  });

  it('STS EMONG — inland center description ("in the vicinity of San Isidro, Abra")', () => {
    const { bulletins, issues } = parseBulletinHtml(html('swb-active-emong.html'));
    expect(issues).toEqual([]);
    expect(bulletins).toHaveLength(1);
    const b = bulletins[0]!;
    expect(b).toMatchObject({
      bulletinNumber: 14,
      pagasaName: 'EMONG',
      category: 'STS',
      issuedAt: '2025-07-25T08:00:00+08:00',
      maxWindsKph: 100,
    });
    expect(b.center?.description).toBe('the vicinity of San Isidro, Abra');
    expect(b.signals.map((s) => s.signalLevel)).toEqual([3, 2, 1]);
    // Signal 3 covers dozens of municipalities across Ilocos/Abra/Apayao.
    expect(b.signals[0]!.areas.length).toBeGreaterThan(30);
  });
});
