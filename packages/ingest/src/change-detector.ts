import type { DomainEvent, ParsedBulletin, WebhookEventType } from '@bagyo/shared';

export interface SignalSnapshotArea {
  psgcCode: string | null;
  locationName: string;
  signalLevel: number;
}

/** Highest signal level per resolved PSGC area. Unresolved areas key by name. */
export function signalStateOf(
  areas: SignalSnapshotArea[],
): Map<string, { level: number; name: string }> {
  const state = new Map<string, { level: number; name: string }>();
  for (const a of areas) {
    const key = a.psgcCode ?? `name:${a.locationName.toLowerCase()}`;
    const prev = state.get(key);
    if (!prev || a.signalLevel > prev.level) {
      state.set(key, { level: a.signalLevel, name: a.locationName });
    }
  }
  return state;
}

export interface ChangeContext {
  cyclone: {
    id: string;
    pagasaName: string;
    internationalName: string | null;
    category: string | null;
  };
  bulletin: { id: string; bulletinNumber: number; issuedAt: string };
  /** Snapshot from the previous bulletin of the same cyclone (empty for the first). */
  previousAreas: SignalSnapshotArea[];
  /** True when this is the cyclone's first stored bulletin. */
  isNewCyclone: boolean;
  parsed: ParsedBulletin;
}

/**
 * Diff the new bulletin against the cyclone's previous state and emit domain
 * events: bulletin.issued always; entered/exited PAR on transitions;
 * signal.raised / signal.lowered per PSGC area whose max level changed.
 */
export function detectChanges(ctx: ChangeContext): DomainEvent[] {
  const { parsed } = ctx;
  const events: DomainEvent[] = [];
  const base = {
    occurredAt: parsed.issuedAt,
    cyclone: ctx.cyclone,
    bulletin: ctx.bulletin,
  };

  const push = (type: WebhookEventType, signal: DomainEvent['signal'] = null) =>
    events.push({ type, ...base, signal });

  push('bulletin.issued');

  const insidePar = parsed.center !== null && !parsed.center.outsidePar;
  if (ctx.isNewCyclone && insidePar) {
    push('cyclone.entered_par');
  }
  if (parsed.isFinal && parsed.center?.outsidePar) {
    push('cyclone.exited_par');
  }

  const prev = signalStateOf(ctx.previousAreas);
  const next = signalStateOf(
    parsed.signals.flatMap((s) =>
      s.areas.map((a) => ({
        psgcCode: a.psgcCode,
        locationName: a.locationName,
        signalLevel: s.signalLevel,
      })),
    ),
  );

  for (const [key, val] of next) {
    const before = prev.get(key);
    if (!before || val.level > before.level) {
      push('signal.raised', {
        psgcCode: key.startsWith('name:') ? null : key,
        locationName: val.name,
        previousLevel: before ? clampLevel(before.level) : null,
        newLevel: clampLevel(val.level),
      });
    } else if (val.level < before.level) {
      push('signal.lowered', {
        psgcCode: key.startsWith('name:') ? null : key,
        locationName: val.name,
        previousLevel: clampLevel(before.level),
        newLevel: clampLevel(val.level),
      });
    }
  }
  for (const [key, before] of prev) {
    if (!next.has(key)) {
      push('signal.lowered', {
        psgcCode: key.startsWith('name:') ? null : key,
        locationName: before.name,
        previousLevel: clampLevel(before.level),
        newLevel: null,
      });
    }
  }

  return events;
}

function clampLevel(level: number): number {
  return Math.min(5, Math.max(1, level));
}
