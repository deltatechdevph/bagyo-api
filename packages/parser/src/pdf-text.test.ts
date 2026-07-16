import { describe, expect, it } from 'vitest';
import { parseBulletinPdfText } from './pdf-text.js';
import { BulletinParseError } from './html.js';

/** Minimal synthetic bulletin text in PAGASA's extracted-PDF shape. */
function synthetic(overrides: Partial<Record<string, string>> = {}): string {
  return [
    overrides.header ?? 'TROPICAL CYCLONE BULLETIN NR. 5',
    overrides.name ?? 'Tropical Storm KIKO (NARI)',
    overrides.issued ?? 'Issued at 11:00 AM, 01 August 2026',
    'Valid for broadcast until the next bulletin at 5:00 PM today.',
    'KIKO MAINTAINS ITS STRENGTH WHILE MOVING WEST NORTHWESTWARD.',
    'Location of Center (10:00 AM)',
    overrides.center ??
      'The center of Tropical Storm KIKO was estimated based on all available data at 315 km East of Virac, Catanduanes (13.9°N, 127.1°E)',
    'Intensity',
    overrides.intensity ??
      'Maximum sustained winds of 85 km/h near the center, gustiness of up to 105 km/h, and central pressure of 996 hPa.',
    'Present Movement',
    'West northwestward at 15 km/h',
    overrides.signals ??
      [
        'TROPICAL CYCLONE WIND SIGNALS (TCWS) IN EFFECT',
        'TCWS No. Luzon Visayas Mindanao',
        'Catanduanes and the eastern portion of Camarines Sur (Caramoan, - -',
        '1',
        'Presentacion)',
        'Wind threat:',
        'Strong',
        'winds',
        'Warning lead time: 36 hours',
        'Range of wind speeds: 39 to 61 km/h (Beaufort 6 to 7)',
        'Potential impacts of winds: Minimal to minor threat to life and property',
      ].join('\n'),
    'OTHER HAZARDS AFFECTING LAND AREAS',
    'The next tropical cyclone bulletin will be issued at 5:00 PM today.',
  ].join('\n');
}

describe('parseBulletinPdfText — synthetic variants', () => {
  it('parses the happy path with a signal row', () => {
    const { bulletin: b, issues } = parseBulletinPdfText(synthetic());
    expect(issues).toEqual([]);
    expect(b).toMatchObject({
      bulletinNumber: 5,
      pagasaName: 'KIKO',
      internationalName: 'NARI',
      category: 'TS',
      issuedAt: '2026-08-01T11:00:00+08:00',
      nextBulletinAt: '2026-08-01T17:00:00+08:00',
      maxWindsKph: 85,
      movementSpeedKph: 15,
    });
    expect(b.signals).toHaveLength(1);
    const areas = b.signals[0]!.areas;
    expect(areas.find((a) => a.locationName === 'Catanduanes')).toMatchObject({
      psgcCode: '052000000',
      locationType: 'PROVINCE',
    });
    expect(areas.find((a) => a.locationName === 'Caramoan')).toMatchObject({
      locationType: 'MUNICIPALITY',
    });
  });

  it('handles "No Wind Signal is currently hoisted"', () => {
    const { bulletin: b } = parseBulletinPdfText(
      synthetic({
        signals:
          'TROPICAL CYCLONE WIND SIGNALS (TCWS) IN EFFECT\nNo Wind Signal is currently hoisted',
      }),
    );
    expect(b.signals).toEqual([]);
  });

  it('throws when the bulletin number is missing', () => {
    expect(() => parseBulletinPdfText(synthetic({ header: 'SOME OTHER DOCUMENT' }))).toThrow(
      BulletinParseError,
    );
  });

  it('throws when the designation line is unparseable', () => {
    expect(() => parseBulletinPdfText(synthetic({ name: 'Mystery Blob' }))).toThrow(
      BulletinParseError,
    );
  });

  it('throws when the issuance time is missing', () => {
    expect(() => parseBulletinPdfText(synthetic({ issued: 'Issued at some point' }))).toThrow(
      BulletinParseError,
    );
  });

  it('throws when a TCWS row has area text but no level (never store garbage)', () => {
    expect(() =>
      parseBulletinPdfText(
        synthetic({
          signals: [
            'TROPICAL CYCLONE WIND SIGNALS (TCWS) IN EFFECT',
            'TCWS No. Luzon Visayas Mindanao',
            'Catanduanes',
            'Wind threat:',
            'Strong winds',
            'Warning lead time: 36 hours',
            'Potential impacts of winds: Minimal',
          ].join('\n'),
        }),
      ),
    ).toThrow(BulletinParseError);
  });

  it('treats a missing center as null rather than failing (validated as nullable)', () => {
    const { bulletin: b } = parseBulletinPdfText(
      synthetic({ center: 'The center could not be determined.' }),
    );
    expect(b.center).toBeNull();
  });

  it('never invents intensity values', () => {
    const { bulletin: b } = parseBulletinPdfText(
      synthetic({ intensity: 'Central pressure of 1002 hPa.' }),
    );
    expect(b.maxWindsKph).toBeNull();
    expect(b.gustinessKph).toBeNull();
    expect(b.pressureHpa).toBe(1002);
  });
});
