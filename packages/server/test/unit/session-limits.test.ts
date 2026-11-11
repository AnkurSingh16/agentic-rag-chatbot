import { describe, expect, it } from 'vitest';
import { MinuteRateLimiter, ipKey } from '../../src/http/limits.js';
import { SESSION_TTL_SECONDS, createSessionSigner } from '../../src/http/session.js';

describe('createSessionSigner', () => {
  it('issues tokens that verify for their instance until they expire', () => {
    let now = Date.UTC(2026, 10, 1);
    const signer = createSessionSigner('s'.repeat(32), () => now);
    const issued = signer.issue('help');
    expect(issued.expiresAt.getTime()).toBe(now + SESSION_TTL_SECONDS * 1000);
    const verified = signer.verify(issued.token, 'help');
    expect(verified?.ownerKey).toMatch(/^[0-9a-f]{64}$/);
    expect(verified?.ownerKey).not.toContain(verified?.sessionId ?? '-');
    expect(signer.verify(issued.token, 'other')).toBeUndefined();
    now += SESSION_TTL_SECONDS * 1000;
    expect(signer.verify(issued.token, 'help')).toBeUndefined();
  });

  it('rejects forged, malformed and differently signed tokens', () => {
    const signer = createSessionSigner('s'.repeat(32));
    const { token } = signer.issue('help');
    const parts = token.split('.');
    const forged = [...parts.slice(0, 3), '9999999999', parts[4]].join('.');
    expect(signer.verify(forged, 'help')).toBeUndefined();
    expect(signer.verify('a.b.c', 'help')).toBeUndefined();
    expect(signer.verify(`${token}x`, 'help')).toBeUndefined();
    expect(createSessionSigner('t'.repeat(32)).verify(token, 'help')).toBeUndefined();
    expect(signer.verify(token, 'help')).toBeDefined();
  });

  it('gives each session its own owner key', () => {
    const signer = createSessionSigner('s'.repeat(32));
    const a = signer.verify(signer.issue('help').token, 'help');
    const b = signer.verify(signer.issue('help').token, 'help');
    expect(a?.ownerKey).not.toBe(b?.ownerKey);
  });
});

describe('ipKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::9', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:ffff::1', '2001:db8:1:2::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['unknown', 'unknown'],
  ])('keys %s as %s', (address, key) => {
    expect(ipKey(address)).toBe(key);
  });
});

describe('MinuteRateLimiter', () => {
  it('allows the limit per key per minute', () => {
    let now = 0;
    const limiter = new MinuteRateLimiter(() => now);
    expect([1, 2, 3].map(() => limiter.take('a', 2))).toEqual([true, true, false]);
    expect(limiter.take('b', 2)).toBe(true);
    now = 60_000;
    expect(limiter.take('a', 2)).toBe(true);
  });

  it('keeps tracking new keys when the table is full', () => {
    let now = 0;
    const limiter = new MinuteRateLimiter(() => now);
    for (let i = 0; i < 50_000; i++) limiter.take(`k${i}`, 1);
    expect(limiter.take('new', 1)).toBe(true);
    expect(limiter.take('new', 1)).toBe(false);
    now = 61_000;
    expect(limiter.take('another', 1)).toBe(true);
  });
});
