import { describe, expect, it } from 'vitest';
import {
  cleanText,
  parseBulletinNumber,
  parseCenter,
  parseIntensity,
  parseMovement,
  parseNameLine,
} from './common.js';

describe('cleanText', () => {
  it('repairs PDF extraction artifacts', () => {
    expect(cleanText('Babuyan Is ., Didicas  Is.')).toBe('Babuyan Is., Didicas Is.');
    expect(cleanText('( Santa Ana ,)')).toBe('(Santa Ana)');
  });
});

describe('parseNameLine', () => {
  it('parses every category prefix', () => {
    expect(parseNameLine('Super Typhoon INDAY (BAVI)')).toMatchObject({
      category: 'STY',
      pagasaName: 'INDAY',
      internationalName: 'BAVI',
    });
    expect(parseNameLine('Typhoon FRANCISCO (MEKKHALA)')).toMatchObject({ category: 'TY' });
    expect(parseNameLine('Severe Tropical Storm FRANCISCO (MEKKHALA)')).toMatchObject({
      category: 'STS',
    });
    expect(parseNameLine('Tropical Storm "Ondoy"')).toMatchObject({
      category: 'TS',
      pagasaName: 'ONDOY',
      internationalName: null,
    });
    expect(parseNameLine('Tropical Depression AGATON')).toMatchObject({ category: 'TD' });
  });

  it('parses HTML quoted names', () => {
    expect(parseNameLine('Super Typhoon "Nando"')).toMatchObject({
      category: 'STY',
      pagasaName: 'NANDO',
    });
  });

  it('parses "(formerly …)" post-cyclone designations with curly quotes', () => {
    expect(parseNameLine('Low Pressure Area (formerly “JOSIE”)')).toMatchObject({
      category: null,
      categoryRaw: 'Low Pressure Area',
      pagasaName: 'JOSIE',
      isFormer: true,
    });
  });

  it('returns null on unrecognizable lines', () => {
    expect(parseNameLine('Weather Division')).toBeNull();
    expect(parseNameLine('')).toBeNull();
  });
});

describe('parseCenter', () => {
  it('parses the standard form', () => {
    expect(
      parseCenter(
        'The center of Typhoon INDAY was estimated based on all available data at 620 km East of Basco, Batanes (20.3°N, 127.9°E).',
      ),
    ).toEqual({
      lat: 20.3,
      lng: 127.9,
      description: '620 km East of Basco, Batanes',
      outsidePar: false,
    });
  });

  it('tolerates spaced degrees and trailing space (HTML variant)', () => {
    expect(parseCenter('at 145 km West of Calayan, Cagayan (19.5 °N, 120.1 °E )')).toMatchObject({
      lat: 19.5,
      lng: 120.1,
      description: '145 km West of Calayan, Cagayan',
    });
  });

  it('tolerates a missing degree symbol on longitude', () => {
    expect(parseCenter('at 1,125 km East of Southeastern Luzon (14.5°N, 134.6E)')).toMatchObject({
      lat: 14.5,
      lng: 134.6,
    });
  });

  it('detects OUTSIDE PAR and strips it from the description', () => {
    const c = parseCenter('at 1,545 km East of Northern Luzon (OUTSIDE PAR) (16.8°N, 136.2°E)');
    expect(c).toMatchObject({
      outsidePar: true,
      description: '1,545 km East of Northern Luzon',
    });
  });

  it('parses vicinity descriptions', () => {
    expect(parseCenter('in the vicinity of San Isidro, Abra (17.5 °N, 120.6 °E)')).toMatchObject({
      description: 'the vicinity of San Isidro, Abra',
    });
  });

  it('returns null when there are no coordinates', () => {
    expect(parseCenter('somewhere over the Philippine Sea')).toBeNull();
  });
});

describe('parseIntensity', () => {
  it('parses all three fields', () => {
    expect(
      parseIntensity(
        'Maximum sustained winds of 150 km/h near the center, gustiness of up to 185 km/h, and central pressure of 955 hPa',
      ),
    ).toEqual({ maxWindsKph: 150, gustinessKph: 185, pressureHpa: 955 });
  });

  it('returns nulls for missing fields — never estimates', () => {
    expect(parseIntensity('Central pressure of 1008 hPa.')).toEqual({
      maxWindsKph: null,
      gustinessKph: null,
      pressureHpa: 1008,
    });
    expect(parseIntensity('')).toEqual({
      maxWindsKph: null,
      gustinessKph: null,
      pressureHpa: null,
    });
  });
});

describe('parseMovement', () => {
  it('parses direction + speed, with or without "Moving"', () => {
    expect(parseMovement('Moving Westward at 20 km/h')).toEqual({
      direction: 'Westward',
      speedKph: 20,
    });
    expect(parseMovement('North northeastward at 15 km/h')).toEqual({
      direction: 'North northeastward',
      speedKph: 15,
    });
  });

  it('handles "Slowly" and "Almost stationary"', () => {
    expect(parseMovement('North northeastward Slowly')).toEqual({
      direction: 'North northeastward',
      speedKph: null,
    });
    expect(parseMovement('Almost stationary')).toEqual({
      direction: 'Almost stationary',
      speedKph: 0,
    });
  });

  it('keeps unknown phrasing as the direction with null speed', () => {
    expect(parseMovement('Drifting erratically')).toEqual({
      direction: 'Drifting erratically',
      speedKph: null,
    });
    expect(parseMovement('')).toEqual({ direction: null, speedKph: null });
  });
});

describe('parseBulletinNumber', () => {
  it('parses PDF and HTML forms', () => {
    expect(parseBulletinNumber('TROPICAL CYCLONE BULLETIN NR. 10')).toEqual({
      bulletinNumber: 10,
      isFinal: false,
    });
    expect(parseBulletinNumber('TROPICAL CYCLONE BULLETIN NR. 16F')).toEqual({
      bulletinNumber: 16,
      isFinal: true,
    });
    expect(parseBulletinNumber('Tropical Cyclone Bulletin #26')).toEqual({
      bulletinNumber: 26,
      isFinal: false,
    });
    expect(parseBulletinNumber('Tropical Cyclone Bulletin #12 - FINAL')).toEqual({
      bulletinNumber: 12,
      isFinal: true,
    });
  });

  it('returns null without a number', () => {
    expect(parseBulletinNumber('Tropical Cyclone Bulletin')).toBeNull();
  });
});
