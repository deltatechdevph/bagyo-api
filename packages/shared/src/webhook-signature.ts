import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook payloads are signed `sha256=HMAC(secret, "<timestamp>.<body>")`.
 * The timestamp is included in the signed material to prevent replay; receivers
 * should reject signatures older than their tolerance (default 5 minutes).
 */
export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `sha256=${mac}`;
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  toleranceMs = 5 * 60_000,
  now: () => number = Date.now,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now() - ts) > toleranceMs) return false;
  const expected = signWebhookPayload(secret, timestamp, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
