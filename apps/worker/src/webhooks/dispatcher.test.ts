import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '@bagyo/shared';
import { subscriptionMatches } from './dispatcher.js';

const signalEvent = (over: Partial<NonNullable<DomainEvent['signal']>> = {}): DomainEvent => ({
  type: 'signal.raised',
  occurredAt: '2026-07-10T05:00:00+08:00',
  cyclone: { id: 'c', pagasaName: 'INDAY', internationalName: null, category: 'TY' },
  bulletin: { id: 'b', bulletinNumber: 3, issuedAt: '2026-07-10T05:00:00+08:00' },
  signal: {
    psgcCode: '031400000',
    locationName: 'Bulacan',
    previousLevel: 1,
    newLevel: 2,
    ...over,
  },
});

const bulletinEvent: DomainEvent = {
  type: 'bulletin.issued',
  occurredAt: '2026-07-10T05:00:00+08:00',
  cyclone: { id: 'c', pagasaName: 'INDAY', internationalName: null, category: 'TY' },
  bulletin: { id: 'b', bulletinNumber: 3, issuedAt: '2026-07-10T05:00:00+08:00' },
  signal: null,
};

const sub = (over: Partial<Parameters<typeof subscriptionMatches>[0]> = {}) => ({
  eventTypes: ['signal.raised', 'signal.lowered', 'bulletin.issued'],
  psgcFilter: [] as string[],
  minSignalLevel: 1,
  ...over,
});

describe('subscriptionMatches', () => {
  it('requires the event type to be subscribed', () => {
    expect(subscriptionMatches(sub({ eventTypes: ['cyclone.entered_par'] }), bulletinEvent)).toBe(
      false,
    );
    expect(subscriptionMatches(sub(), bulletinEvent)).toBe(true);
  });

  it('matches signal events against the PSGC filter', () => {
    expect(subscriptionMatches(sub({ psgcFilter: ['031400000'] }), signalEvent())).toBe(true);
    expect(subscriptionMatches(sub({ psgcFilter: ['999999999'] }), signalEvent())).toBe(false);
  });

  it('skips area-less events when a PSGC filter is set', () => {
    expect(subscriptionMatches(sub({ psgcFilter: ['031400000'] }), bulletinEvent)).toBe(false);
  });

  it('skips unresolved-area signal events when a PSGC filter is set', () => {
    expect(
      subscriptionMatches(sub({ psgcFilter: ['031400000'] }), signalEvent({ psgcCode: null })),
    ).toBe(false);
  });

  it('applies minSignalLevel using the max of previous/new ("Bulacan reaches Signal 2+")', () => {
    expect(subscriptionMatches(sub({ minSignalLevel: 2 }), signalEvent({ newLevel: 2 }))).toBe(
      true,
    );
    expect(
      subscriptionMatches(
        sub({ minSignalLevel: 3 }),
        signalEvent({ previousLevel: 1, newLevel: 2 }),
      ),
    ).toBe(false);
    // Lowering from 3 to 1 still matters to a min-2 subscriber.
    expect(
      subscriptionMatches(sub({ minSignalLevel: 2 }), {
        ...signalEvent({ previousLevel: 3, newLevel: 1 }),
        type: 'signal.lowered',
      }),
    ).toBe(true);
  });
});
