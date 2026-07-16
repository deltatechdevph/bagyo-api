import { fetch } from 'undici';
import type { Logger } from 'pino';
import { CircuitBreaker } from './circuit-breaker.js';

export class FetchError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export class CircuitOpenError extends Error {
  constructor(readonly host: string) {
    super(`circuit open for ${host}`);
    this.name = 'CircuitOpenError';
  }
}

export interface PoliteFetcherOptions {
  userAgent: string;
  /** Minimum delay between requests to the same host (ms). Default 5000. */
  minHostDelayMs?: number;
  /** Max retries on 5xx / network errors. Default 5. */
  maxRetries?: number;
  /** Base backoff (ms), doubled per retry. Default 1000. */
  backoffBaseMs?: number;
  /** Circuit breaker: consecutive failures before opening. Default 3. */
  breakerThreshold?: number;
  /** Circuit breaker cooldown. Default 15 minutes. */
  breakerCooldownMs?: number;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FetchedDocument {
  body: Buffer;
  statusCode: number;
  finalUrl: string;
  contentType: string | null;
}

/**
 * Polite HTTP client for scraping PAGASA:
 *  - honest User-Agent
 *  - ≥5s spacing between requests to the same host
 *  - exponential backoff on 5xx / network errors (max 5 retries)
 *  - circuit breaker pauses a host for 15 minutes after repeated failures
 */
export class PoliteFetcher {
  private readonly lastRequestAt = new Map<string, number>();
  private readonly breaker: CircuitBreaker;
  private readonly opts: Required<
    Pick<PoliteFetcherOptions, 'minHostDelayMs' | 'maxRetries' | 'backoffBaseMs' | 'userAgent'>
  >;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly logger: Logger | undefined;

  constructor(options: PoliteFetcherOptions) {
    this.opts = {
      userAgent: options.userAgent,
      minHostDelayMs: options.minHostDelayMs ?? 5_000,
      maxRetries: options.maxRetries ?? 5,
      backoffBaseMs: options.backoffBaseMs ?? 1_000,
    };
    this.breaker = new CircuitBreaker({
      threshold: options.breakerThreshold ?? 3,
      cooldownMs: options.breakerCooldownMs ?? 15 * 60_000,
      now: options.now,
    });
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  async fetch(url: string, maxRedirects = 5): Promise<FetchedDocument> {
    const host = new URL(url).host;
    if (this.breaker.isOpen(host)) {
      throw new CircuitOpenError(host);
    }

    let attempt = 0;
    for (;;) {
      await this.waitForHostSlot(host);
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { 'user-agent': this.opts.userAgent, accept: '*/*' },
          redirect: maxRedirects > 0 ? 'follow' : 'manual',
          signal: AbortSignal.timeout(60_000),
        });
        if (res.status >= 500) {
          await res.arrayBuffer().catch(() => undefined);
          throw new FetchError(`upstream ${res.status}`, res.status);
        }
        if (res.status >= 400) {
          await res.arrayBuffer().catch(() => undefined);
          this.breaker.recordSuccess(host); // 4xx is a valid answer, not an outage
          throw new FetchError(`client error ${res.status}`, res.status);
        }
        const body = Buffer.from(await res.arrayBuffer());
        this.breaker.recordSuccess(host);
        return {
          body,
          statusCode: res.status,
          finalUrl: res.url || url,
          contentType: res.headers.get('content-type'),
        };
      } catch (err) {
        if (err instanceof FetchError && err.statusCode !== undefined && err.statusCode < 500) {
          throw err; // 4xx: do not retry, do not trip the breaker
        }
        this.breaker.recordFailure(host);
        attempt += 1;
        if (attempt > this.opts.maxRetries || this.breaker.isOpen(host)) {
          throw err instanceof Error ? err : new FetchError(String(err));
        }
        const backoff = this.opts.backoffBaseMs * 2 ** (attempt - 1);
        this.logger?.warn({ url, attempt, backoff }, 'fetch failed, backing off');
        await this.sleep(backoff);
      }
    }
  }

  private async waitForHostSlot(host: string): Promise<void> {
    const last = this.lastRequestAt.get(host) ?? 0;
    const wait = last + this.opts.minHostDelayMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt.set(host, this.now());
  }
}
