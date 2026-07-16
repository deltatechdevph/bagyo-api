import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('CircuitBreaker', () => {
  it('opens after the failure threshold', () => {
    const c = clock();
    const b = new CircuitBreaker({ threshold: 3, cooldownMs: 15 * 60_000, now: c.now });
    b.recordFailure('pagasa');
    b.recordFailure('pagasa');
    expect(b.isOpen('pagasa')).toBe(false);
    b.recordFailure('pagasa');
    expect(b.isOpen('pagasa')).toBe(true);
    expect(b.remainingMs('pagasa')).toBe(15 * 60_000);
  });

  it('half-opens after the cooldown and re-opens on the next failure', () => {
    const c = clock();
    const b = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000, now: c.now });
    b.recordFailure('h');
    b.recordFailure('h');
    expect(b.isOpen('h')).toBe(true);
    c.advance(60_000);
    expect(b.isOpen('h')).toBe(false); // half-open probe allowed
    b.recordFailure('h'); // probe failed
    expect(b.isOpen('h')).toBe(true);
  });

  it('closes fully on success', () => {
    const c = clock();
    const b = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000, now: c.now });
    b.recordFailure('h');
    b.recordSuccess('h');
    b.recordFailure('h');
    expect(b.isOpen('h')).toBe(false);
  });

  it('tracks keys independently', () => {
    const b = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000, now: clock().now });
    b.recordFailure('a');
    expect(b.isOpen('a')).toBe(true);
    expect(b.isOpen('b')).toBe(false);
  });
});
