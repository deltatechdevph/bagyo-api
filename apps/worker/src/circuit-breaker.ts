/**
 * Per-key circuit breaker: after `threshold` consecutive failures the circuit
 * opens for `cooldownMs` (source is paused), then half-opens to allow one probe.
 */
export interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
}

export interface CircuitBreakerOptions {
  threshold: number;
  cooldownMs: number;
  now?: () => number;
}

export class CircuitBreaker {
  private readonly states = new Map<string, BreakerState>();
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions) {
    this.threshold = opts.threshold;
    this.cooldownMs = opts.cooldownMs;
    this.now = opts.now ?? Date.now;
  }

  private state(key: string): BreakerState {
    let s = this.states.get(key);
    if (!s) {
      s = { consecutiveFailures: 0, openedAt: null };
      this.states.set(key, s);
    }
    return s;
  }

  /** True when requests to this key are currently blocked. */
  isOpen(key: string): boolean {
    const s = this.state(key);
    if (s.openedAt === null) return false;
    if (this.now() - s.openedAt >= this.cooldownMs) {
      // Half-open: allow one probe; failure re-opens with a fresh cooldown.
      s.openedAt = null;
      s.consecutiveFailures = this.threshold - 1;
      return false;
    }
    return true;
  }

  recordSuccess(key: string): void {
    const s = this.state(key);
    s.consecutiveFailures = 0;
    s.openedAt = null;
  }

  recordFailure(key: string): void {
    const s = this.state(key);
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= this.threshold) {
      s.openedAt = this.now();
    }
  }

  /** ms until the circuit half-opens, or 0 when closed. */
  remainingMs(key: string): number {
    const s = this.state(key);
    if (s.openedAt === null) return 0;
    return Math.max(0, this.cooldownMs - (this.now() - s.openedAt));
  }
}
