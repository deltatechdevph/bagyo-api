import { describe, expect, it } from 'vitest';
import { signWebhookPayload, verifyWebhookSignature } from './webhook-signature.js';

describe('webhook signatures', () => {
  const secret = 'whsec_test_secret';
  const body = '{"event":"signal.raised"}';

  it('produces a stable sha256= signature over timestamp.body', () => {
    const sig = signWebhookPayload(secret, '1700000000000', body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sig).toBe(signWebhookPayload(secret, '1700000000000', body));
  });

  it('verifies a fresh, correct signature', () => {
    const now = () => 1_700_000_000_000;
    const ts = String(now());
    const sig = signWebhookPayload(secret, ts, body);
    expect(verifyWebhookSignature(secret, ts, body, sig, 5 * 60_000, now)).toBe(true);
  });

  it('rejects tampered bodies and wrong secrets', () => {
    const now = () => 1_700_000_000_000;
    const ts = String(now());
    const sig = signWebhookPayload(secret, ts, body);
    expect(verifyWebhookSignature(secret, ts, body + 'x', sig, 5 * 60_000, now)).toBe(false);
    expect(verifyWebhookSignature('other', ts, body, sig, 5 * 60_000, now)).toBe(false);
  });

  it('rejects replays outside the tolerance window', () => {
    const ts = '1700000000000';
    const sig = signWebhookPayload(secret, ts, body);
    const later = () => 1_700_000_000_000 + 6 * 60_000;
    expect(verifyWebhookSignature(secret, ts, body, sig, 5 * 60_000, later)).toBe(false);
  });

  it('rejects malformed timestamps', () => {
    const sig = signWebhookPayload(secret, 'nan', body);
    expect(verifyWebhookSignature(secret, 'nan', body, sig)).toBe(false);
  });
});
