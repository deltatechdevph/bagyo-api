import { describe, expect, it } from 'vitest';
import { parsePagasaDateTime, parseRelativePagasaTime } from './time.js';

describe('parsePagasaDateTime', () => {
  it('parses morning issuance', () => {
    expect(parsePagasaDateTime('Issued at 5:00 AM, 10 July 2026')).toBe(
      '2026-07-10T05:00:00+08:00',
    );
  });

  it('parses lowercase pm (HTML variant)', () => {
    expect(parsePagasaDateTime('Issued at 11:00 pm, 22 September 2025')).toBe(
      '2025-09-22T23:00:00+08:00',
    );
  });

  it('parses 12-hour edges', () => {
    expect(parsePagasaDateTime('12:00 AM, 01 January 2026')).toBe('2026-01-01T00:00:00+08:00');
    expect(parsePagasaDateTime('12:00 PM, 01 January 2026')).toBe('2026-01-01T12:00:00+08:00');
    expect(parsePagasaDateTime('12:00 NN, 01 January 2026')).toBe('2026-01-01T12:00:00+08:00');
  });

  it('returns null on garbage instead of guessing', () => {
    expect(parsePagasaDateTime('no timestamp here')).toBeNull();
    expect(parsePagasaDateTime('25:00 AM, 10 July 2026')).toBeNull();
    expect(parsePagasaDateTime('5:00 AM, 10 Julember 2026')).toBeNull();
  });
});

describe('parseRelativePagasaTime', () => {
  const issued = '2026-07-10T05:00:00+08:00';

  it('resolves "today" after issuance', () => {
    expect(parseRelativePagasaTime('the next bulletin at 11:00 AM today', issued)).toBe(
      '2026-07-10T11:00:00+08:00',
    );
  });

  it('resolves "tomorrow"', () => {
    expect(parseRelativePagasaTime('to be issued at 5:00 AM tomorrow', issued)).toBe(
      '2026-07-11T05:00:00+08:00',
    );
  });

  it('assumes tomorrow when the bare time already passed', () => {
    expect(parseRelativePagasaTime('at 2:00 AM', issued)).toBe('2026-07-11T02:00:00+08:00');
  });

  it('crosses month boundaries correctly', () => {
    expect(parseRelativePagasaTime('at 5:00 AM tomorrow', '2026-07-31T23:00:00+08:00')).toBe(
      '2026-08-01T05:00:00+08:00',
    );
  });

  it('returns null without a parsable time', () => {
    expect(parseRelativePagasaTime('soon', issued)).toBeNull();
  });
});
