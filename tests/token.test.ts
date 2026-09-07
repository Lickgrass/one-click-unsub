import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';
import { createTokenCodec } from '../src/token.js';

const SECRET = 'unit-test-secret-at-least-thirty-two-bytes-long';

// Deliberately sign outside the codec to exercise validation after authentication.
function signBody(body: string): string {
  const key = createHash('sha256').update(`unsubscribe:${SECRET}`).digest();
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

function signJson(json: string): string {
  return signBody(Buffer.from(json).toString('base64url'));
}

describe('token codec', () => {
  it('round-trips a freshly minted token and lower-cases the address', () => {
    const c = createTokenCodec({ secret: SECRET });
    const tok = c.mint({ list: 'newsletter', email: 'Alice@Example.COM ' });
    const p = c.verify(tok);
    expect(p).not.toBeNull();
    expect(p!.list).toBe('newsletter');
    expect(p!.email).toBe('alice@example.com');
    expect(p!.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects a forged tag', () => {
    const c = createTokenCodec({ secret: SECRET });
    const tok = c.mint({ list: 'l', email: 'a@b.co' });
    const dot = tok.indexOf('.');
    expect(c.verify(tok.slice(0, dot + 1) + 'AAAA' + tok.slice(dot + 5))).toBeNull();
  });

  it('rejects a modified payload', () => {
    const c = createTokenCodec({ secret: SECRET });
    const tok = c.mint({ list: 'l', email: 'a@b.co' });
    expect(c.verify((tok[0] === 'A' ? 'B' : 'A') + tok.slice(1))).toBeNull();
  });

  it('rejects empty and malformed input without throwing', () => {
    const c = createTokenCodec({ secret: SECRET });
    for (const bad of ['', null, undefined, 'no-dot-here', '.tag-only', 'payload-only.', 'a.b.c', '%%%.%%%']) {
      expect(c.verify(bad as string)).toBeNull();
    }
  });

  it('rejects an expired token', () => {
    let t = Date.parse('2026-01-01T00:00:00Z');
    const c = createTokenCodec({ secret: SECRET, now: () => t });
    const tok = c.mint({ list: 'l', email: 'a@b.co', ttlMs: 60_000 });
    t += 60 * 60 * 1000;
    expect(c.verify(tok)).toBeNull();
  });

  it('enforces a one-minute floor on ttl', () => {
    let t = 1_000_000;
    const c = createTokenCodec({ secret: SECRET, now: () => t });
    const tok = c.mint({ list: 'l', email: 'a@b.co', ttlMs: 1 });
    t += 30_000;
    expect(c.verify(tok)).not.toBeNull();
  });

  it('refuses a short secret', () => {
    expect(() => createTokenCodec({ secret: 'short' })).toThrow(/32 characters/);
  });

  it('is domain-separated: a token for another purpose never verifies', () => {
    const unsub = createTokenCodec({ secret: SECRET, purpose: 'unsubscribe' });
    const confirm = createTokenCodec({ secret: SECRET, purpose: 'confirm' });
    const tok = confirm.mint({ list: 'l', email: 'a@b.co' });
    expect(confirm.verify(tok)).not.toBeNull();
    expect(unsub.verify(tok)).toBeNull();
  });

  it('accepts tokens signed with a previous secret during rotation', () => {
    const old = createTokenCodec({ secret: SECRET });
    const tok = old.mint({ list: 'l', email: 'a@b.co' });
    const rotated = createTokenCodec({ secret: 'a-brand-new-secret-that-is-also-long-enough-ok', previousSecrets: [SECRET] });
    expect(rotated.verify(tok)).not.toBeNull();
    const fresh = rotated.mint({ list: 'l', email: 'a@b.co' });
    expect(old.verify(fresh)).toBeNull();
  });

  it('preserves existing token format and signatures', () => {
    const c = createTokenCodec({ secret: SECRET, now: () => 1_000_000 });
    const existing = 'eyJsIjoibmV3c2xldHRlciIsImUiOiJhbGljZUBleGFtcGxlLmNvbSIsIngiOjMxNTM3MDAwMDAwfQ.uj-53vUE8KA_K-Vxg6OupDReeQiYEljJztcjkwIjN2E';
    expect(c.mint({ list: 'newsletter', email: 'alice@example.com' })).toBe(existing);
    expect(c.verify(existing)).toEqual({ list: 'newsletter', email: 'alice@example.com', expiresAt: 31_537_000_000 });
  });

  it('rejects alternate encodings of the same signature', () => {
    const c = createTokenCodec({ secret: SECRET });
    const token = c.mint({ list: 'l', email: 'a@b.co' });
    const [body, tag] = token.split('.') as [string, string];
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    // A SHA-256 tag uses only four bits of its final base64url character.
    const alternateLast = alphabet[alphabet.indexOf(tag.at(-1)!) + 1]!;
    const alternateTag = tag.slice(0, -1) + alternateLast;
    expect(Buffer.from(alternateTag, 'base64url')).toEqual(Buffer.from(tag, 'base64url'));
    for (const alternate of [token + '=', token + '.', token + '\n', `${body}.${tag.slice(0, 10)} ${tag.slice(10)}`, `${body}.${alternateTag}`]) {
      expect(c.verify(alternate)).toBeNull();
    }
  });

  it('rejects invalid signed JSON shapes without throwing', () => {
    const c = createTokenCodec({ secret: SECRET, now: () => 1_000 });
    for (const json of ['null', 'true', '0', '"text"', '[]', '{}', '{', '{"l":"l","e":"a@b.co","x":1e309}',
      '{"l":"l","e":"a@b.co","x":9007199254740992}', '{"l":"l","e":"a@b.co","x":2000.5}',
      '{"l":"","e":"a@b.co","x":2000}', '{"l":"l","e":"","x":2000}',
      '{"l":1,"e":"a@b.co","x":2000}', '{"l":"l","e":"Alice@Example.com","x":2000}',
      '{"l":"l","e":" a@b.co","x":2000}', '{"l":"\\n","e":"a@b.co","x":2000}']) {
      expect(c.verify(signJson(json))).toBeNull();
    }
  });

  it('rejects noncanonical payload encodings even with a valid signature', () => {
    const c = createTokenCodec({ secret: SECRET, now: () => 1_000 });
    const body = Buffer.from('{"l":"l","e":"a@b.co","x":2000}').toString('base64url');
    expect(c.verify(signBody(body))).not.toBeNull();
    for (const alternate of [body + '=', body + '\n', body.slice(0, 4) + '!' + body.slice(4)]) {
      expect(c.verify(signBody(alternate))).toBeNull();
    }
  });

  it('rejects signed payloads with invalid UTF-8', () => {
    const c = createTokenCodec({ secret: SECRET, now: () => 1_000 });
    const bytes = Buffer.concat([Buffer.from('{"l":"'), Buffer.from([0xff]), Buffer.from('","e":"a@b.co","x":2000}')]);
    expect(c.verify(signBody(bytes.toString('base64url')))).toBeNull();
  });

  it('rejects oversized tokens and refuses to mint unverifiable ones', () => {
    const c = createTokenCodec({ secret: SECRET });
    const valid = c.mint({ list: 'l', email: 'a@b.co' });
    expect(c.verify('A'.repeat(100_000) + valid)).toBeNull();
    expect(() => c.mint({ list: 'a'.repeat(8193), email: 'a@b.co' })).toThrow(/8192/);
    expect(() => c.mint({ list: 'a'.repeat(7000), email: 'a@b.co' })).toThrow(/8192/);
    expect(() => c.mint({ list: '🙂'.repeat(2000), email: 'a@b.co' })).toThrow(/8192/);
    expect(c.verify(c.mint({ list: 'a'.repeat(5000), email: 'a@b.co' }))).not.toBeNull();
  });

  it('validates identity inputs before minting', () => {
    const c = createTokenCodec({ secret: SECRET });
    for (const bad of ['', '   ', '\nlist', 'a\u0000b', 1, null, {}]) {
      expect(() => c.mint({ list: bad as string, email: 'a@b.co' })).toThrow(/list/);
      expect(() => c.mint({ list: 'l', email: bad as string })).toThrow(/email/);
    }
    const token = c.mint({ list: '製品のお知らせ', email: ' Élodie@Example.com ' });
    expect(c.verify(token)).toMatchObject({ list: '製品のお知らせ', email: 'élodie@example.com' });
  });

  it('rejects invalid and overflowing lifetimes', () => {
    const c = createTokenCodec({ secret: SECRET, now: () => 1_000 });
    for (const ttlMs of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '1000']) {
      expect(() => createTokenCodec({ secret: SECRET, ttlMs: ttlMs as number })).toThrow(/ttlMs/);
      expect(() => c.mint({ list: 'l', email: 'a@b.co', ttlMs: ttlMs as number })).toThrow(/ttlMs/);
    }
    expect(() => c.mint({ list: 'l', email: 'a@b.co', ttlMs: Number.MAX_SAFE_INTEGER })).toThrow(/expiry/);
  });

  it('fails closed if the clock becomes invalid and expires at the exact boundary', () => {
    let time = 1_000;
    const c = createTokenCodec({ secret: SECRET, now: () => time });
    const token = c.mint({ list: 'l', email: 'a@b.co', ttlMs: 60_000 });
    time = 60_999;
    expect(c.verify(token)).not.toBeNull();
    for (time of [61_000, NaN, Infinity, -1, 1000.5]) expect(c.verify(token)).toBeNull();
    time = NaN;
    expect(() => c.mint({ list: 'l', email: 'a@b.co' })).toThrow(/clock/);
  });

  it('rejects ambiguous domain labels and invalid rotation configuration', () => {
    for (const purpose of ['', 'unsubscribe:other', ' spaced ', 'unsubscribe\n', 'é', 'a'.repeat(129), 1]) {
      expect(() => createTokenCodec({ secret: SECRET, purpose: purpose as string })).toThrow(/purpose/);
    }
    expect(() => createTokenCodec({ secret: SECRET, previousSecrets: Array(65).fill(SECRET) })).toThrow(/at most 64/);
    expect(() => createTokenCodec({ secret: SECRET, previousSecrets: ['short'] })).toThrow(/32 characters/);
    expect(() => createTokenCodec({ secret: SECRET, previousSecrets: SECRET as unknown as string[] })).toThrow(/array/);
  });

  it('checks every allowed previous secret and lets retired keys be removed', () => {
    const secrets = Array.from({ length: 64 }, (_, index) => `${index}-${SECRET}`);
    const rotated = createTokenCodec({ secret: SECRET, previousSecrets: secrets });
    const retired = createTokenCodec({ secret: SECRET });
    for (const secret of secrets) {
      const token = createTokenCodec({ secret }).mint({ list: 'l', email: 'a@b.co' });
      expect(rotated.verify(token)).not.toBeNull();
      expect(retired.verify(token)).toBeNull();
    }
  });
});
