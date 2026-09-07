/**
 * Stateless, HMAC-signed unsubscribe tokens.
 *
 * Shape: `payload.tag`
 *   payload = base64url(JSON({ l: list, e: emailLower, x: expiresAtMs }))
 *   tag     = base64url(HMAC-SHA256(payload, derivedKey))
 *
 * The key is derived per PURPOSE — sha256(`${purpose}:${secret}`) — so a
 * token minted for one purpose (say, a double-opt-in confirm) can never be
 * replayed against the unsubscribe endpoint, even with a shared secret.
 * Purpose labels cannot contain ':' so the key input is unambiguous.
 *
 * Why HMAC and not a token table: marketing addresses are the ones you
 * send to the most. A table either grows without bound or expires and
 * breaks "unsubscribe from an email I archived eight months ago". A
 * self-contained token verifies with no lookup. The suppression callback
 * must be idempotent. Tokens are bearer credentials and remain valid until
 * expiry or removal of their signing key.
 */
import { Buffer } from 'node:buffer';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface UnsubscribePayload {
  /** The list / audience / segment this address unsubscribes from. */
  list: string;
  /** Lower-cased, trimmed recipient address. */
  email: string;
  /** Expiry, epoch milliseconds. */
  expiresAt: number;
}

export interface TokenCodecOptions {
  /** Randomly generated secret, ≥ 32 characters. Keep it out of logs and git. */
  secret: string;
  /** Up to 64 older secrets still accepted on verify — for rotation without
   *  breaking links already in inboxes. New tokens use `secret`. */
  previousSecrets?: string[] | undefined;
  /** Domain separation label: 1–128 ASCII letters, digits, '.', '_' or '-'.
   *  Default 'unsubscribe'. */
  purpose?: string | undefined;
  /** Positive safe integer lifetime for minted tokens, ms (minimum 1 minute).
   *  Default 365 days, so links keep working long after send. */
  ttlMs?: number | undefined;
  /** Clock, for tests. */
  now?: (() => number) | undefined;
}

export const DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 60_000;
const MIN_SECRET_LENGTH = 32;
const MAX_PREVIOUS_SECRETS = 64;
const MAX_TOKEN_LENGTH = 8192;
const TAG_LENGTH = 43; // Unpadded base64url encoding of a 32-byte SHA-256 HMAC.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

export function b64urlDecode(s: string): Buffer {
  // Buffer's decoder also accepts padding, whitespace and the base64 alphabet.
  // Require a single canonical representation, including zero unused pad bits.
  if (typeof s !== 'string' || /[^A-Za-z0-9_-]/.test(s) || s.length % 4 === 1) {
    throw new Error('one-click-unsub: invalid base64url');
  }
  const decoded = Buffer.from(s, 'base64url');
  if (b64urlEncode(decoded) !== s) throw new Error('one-click-unsub: invalid base64url');
  return decoded;
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH
    && !CONTROL_CHARACTERS.test(value) && value.trim().length > 0;
}

function validateTtl(ttl: number): number {
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new Error('one-click-unsub: ttlMs must be a positive safe integer');
  }
  return Math.max(MIN_TTL_MS, ttl);
}

function deriveKey(secret: string, purpose: string): Buffer {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`one-click-unsub: secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return createHash('sha256').update(`${purpose}:${secret}`).digest();
}

export interface TokenCodec {
  /** Mints a token of at most 8192 characters. Identities must be nonempty
   *  strings without control characters; invalid inputs throw. */
  mint(input: { list: string; email: string; ttlMs?: number | undefined }): string;
  /** Returns the payload for a valid, unexpired token; null otherwise.
   *  Never throws on bad input. */
  verify(token: string | null | undefined): UnsubscribePayload | null;
}

export function createTokenCodec(options: TokenCodecOptions): TokenCodec {
  const purpose = options.purpose ?? 'unsubscribe';
  if (typeof purpose !== 'string' || purpose.length < 1 || purpose.length > 128 || /[^A-Za-z0-9._-]/.test(purpose)) {
    throw new Error('one-click-unsub: purpose must be 1–128 ASCII letters, digits, dots, underscores or hyphens');
  }
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') throw new Error('one-click-unsub: now must be a function');
  const previousSecrets = options.previousSecrets ?? [];
  if (!Array.isArray(previousSecrets) || previousSecrets.length > MAX_PREVIOUS_SECRETS) {
    throw new Error(`one-click-unsub: previousSecrets must be an array of at most ${MAX_PREVIOUS_SECRETS} secrets`);
  }
  const keys = [options.secret, ...previousSecrets].map((s) =>
    deriveKey(s, purpose),
  );
  const current = keys[0]!;
  const defaultTtl = validateTtl(options.ttlMs ?? DEFAULT_TTL_MS);

  function tagFor(body: string, key: Buffer): Buffer {
    return createHmac('sha256', key).update(body).digest();
  }

  return {
    mint({ list, email, ttlMs }) {
      if (!validIdentity(list)) throw new Error('one-click-unsub: list must be a nonempty string without control characters (at most 8192 characters)');
      if (!validIdentity(email)) throw new Error('one-click-unsub: email must be a nonempty string without control characters (at most 8192 characters)');
      const normalized = email.toLowerCase().trim();
      const time = now();
      const expiresAt = time + validateTtl(ttlMs ?? defaultTtl);
      if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(expiresAt)) {
        throw new Error('one-click-unsub: clock and expiry must be safe nonnegative epoch milliseconds');
      }
      const body = b64urlEncode(
        Buffer.from(
          JSON.stringify({
            l: list,
            e: normalized,
            x: expiresAt,
          }),
        ),
      );
      if (body.length + 1 + TAG_LENGTH > MAX_TOKEN_LENGTH) {
        throw new Error(`one-click-unsub: encoded token must not exceed ${MAX_TOKEN_LENGTH} characters`);
      }
      return `${body}.${b64urlEncode(tagFor(body, current))}`;
    },

    verify(token) {
      if (!token || typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null;
      const dot = token.indexOf('.');
      if (dot <= 0 || token.length - dot - 1 !== TAG_LENGTH) return null;
      const body = token.slice(0, dot);
      const tag = token.slice(dot + 1);
      let provided: Buffer;
      try {
        provided = b64urlDecode(tag);
      } catch {
        return null;
      }
      // Compare all accepted keys in constant time, without stopping at the
      // matching key. Overall verification time still depends on the input.
      let ok = false;
      for (const key of keys) {
        const expected = tagFor(body, key);
        if (expected.length === provided.length && timingSafeEqual(expected, provided)) ok = true;
      }
      if (!ok) return null;
      let parsed: unknown;
      try {
        const decoded = b64urlDecode(body);
        const json = decoded.toString('utf8');
        if (!Buffer.from(json, 'utf8').equals(decoded)) return null;
        parsed = JSON.parse(json);
      } catch {
        return null;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      const { l, e, x } = parsed as { l?: unknown; e?: unknown; x?: unknown };
      if (!validIdentity(l) || !validIdentity(e) || e !== e.toLowerCase().trim()
        || typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) {
        return null;
      }
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0 || x <= time) return null;
      return { list: l, email: e, expiresAt: x };
    },
  };
}
