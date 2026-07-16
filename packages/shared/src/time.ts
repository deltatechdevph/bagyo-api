/** Philippine Standard Time is UTC+8, no DST. */
export const PH_UTC_OFFSET = '+08:00';

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/**
 * Parse PAGASA's issuance timestamps, e.g. "5:00 AM, 10 July 2026" or
 * "11:00 pm, 22 September 2025", into an ISO-8601 string with the +08:00 offset.
 * Returns null on anything it cannot understand — never guesses.
 */
export function parsePagasaDateTime(text: string): string | null {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM|NN|MN)\s*,?\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i.exec(
    text,
  );
  if (!m) return null;
  const [, hRaw, minRaw, meridiemRaw, dayRaw, monthRaw, yearRaw] = m;
  if (!hRaw || !minRaw || !meridiemRaw || !dayRaw || !monthRaw || !yearRaw) return null;
  const month = MONTHS[monthRaw.toLowerCase()];
  if (!month) return null;
  let hour = Number(hRaw);
  const meridiem = meridiemRaw.toUpperCase();
  if (hour < 1 || hour > 12) return null;
  // PAGASA occasionally writes "12:00 NN" (noon) and "12:00 MN" (midnight).
  if (meridiem === 'PM' || meridiem === 'NN') {
    if (hour !== 12) hour += 12;
    if (meridiem === 'NN') hour = 12;
  } else if (hour === 12) {
    hour = 0; // 12 AM / 12 MN
  }
  const day = Number(dayRaw);
  const year = Number(yearRaw);
  if (day < 1 || day > 31) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${minRaw}:00${PH_UTC_OFFSET}`;
}

/**
 * Resolve phrases like "the next bulletin at 11:00 AM today" or
 * "to be issued at 5:00 AM tomorrow" relative to the bulletin's own issuance time.
 */
export function parseRelativePagasaTime(text: string, issuedAtIso: string): string | null {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM|NN|MN)\s*(today|tomorrow)?/i.exec(text);
  if (!m) return null;
  const [, hRaw, minRaw, meridiemRaw, dayWord] = m;
  if (!hRaw || !minRaw || !meridiemRaw) return null;
  let hour = Number(hRaw);
  const meridiem = meridiemRaw.toUpperCase();
  if (hour < 1 || hour > 12) return null;
  if (meridiem === 'PM' || meridiem === 'NN') {
    if (hour !== 12) hour += 12;
    if (meridiem === 'NN') hour = 12;
  } else if (hour === 12) {
    hour = 0;
  }
  const issued = new Date(issuedAtIso);
  if (Number.isNaN(issued.getTime())) return null;
  // Work in PH wall-clock time by shifting to UTC+8.
  const phMillis = issued.getTime() + 8 * 3600_000;
  const ph = new Date(phMillis);
  const base = Date.UTC(
    ph.getUTCFullYear(),
    ph.getUTCMonth(),
    ph.getUTCDate(),
    hour,
    Number(minRaw),
    0,
  );
  let target = base;
  if (/tomorrow/i.test(dayWord ?? '')) {
    target += 24 * 3600_000;
  } else if (!dayWord && target <= phMillis) {
    // No day word and the time already passed today in PH — assume tomorrow.
    target += 24 * 3600_000;
  }
  const t = new Date(target); // holds PH wall-clock fields in its UTC accessors
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00${PH_UTC_OFFSET}`
  );
}
