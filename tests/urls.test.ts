import { describe, expect, it, vi } from 'vitest';
import { createUnsubscribe, type UnsubscribeOptions } from '../src/index.js';

const options = {
  secret: 'unit-test-secret-at-least-thirty-two-bytes-long',
  baseUrl: 'https://mail.example.com',
  address: 'Acme, 123 Main St',
};

describe('URL configuration', () => {
  it.each([
    'https://example.com/base',
    'https://example.com/..',
    'https://example.com/%2e',
    'https://example.com?query=value',
    'https://example.com?',
    'https://example.com/#fragment',
    'https://user:password@example.com',
  ])('rejects a base URL that is not an origin: %j', (baseUrl) => {
    expect(() => createUnsubscribe({ ...options, baseUrl })).toThrow(/baseUrl/);
  });

  it.each([
    '/unsubscribe',
    '/u/:token/:token',
    'unsubscribe/:token',
    '//evil.example/:token',
    '/u/#:token',
    '/u/:token#ignored',
    '/u/../:token',
    '/u/%2e%2e/:token',
    '/u/:token\r\nBcc: victim@example.com',
    '/u/:token" onclick="alert(1)',
    '/u\\:token',
    '/u/:token?bad=%ZZ',
  ])('rejects an invalid route template at construction: %j', (path) => {
    expect(() => createUnsubscribe({ ...options, oneClickPath: path })).toThrow(/oneClickPath/);
    expect(() => createUnsubscribe({ ...options, confirmPath: path })).toThrow(/confirmPath/);
  });

  it('normalizes the origin and encodes token contents without changing the host or query structure', () => {
    const unsub = createUnsubscribe({ ...options, baseUrl: 'https://MAIL.example.com:443/' });
    const token = 'token/with?query=value#fragment&extra';
    const urls = unsub.urls(token);
    expect(urls.oneClick).toBe(`https://mail.example.com/unsubscribe/${encodeURIComponent(token)}`);
    expect(new URL(urls.oneClick).search).toBe('');
    expect(new URL(urls.oneClick).hash).toBe('');
  });

  it.each(['', '.', '..'])('rejects tokens that disappear during URL parsing: %j', (token) => {
    expect(() => createUnsubscribe(options).urls(token)).toThrow(/token/);
  });

  it('rejects invalid sender and address configuration before the first send', () => {
    expect(() => createUnsubscribe({ ...options, from: 'a@invalid..domain' })).toThrow(/mailto domain/);
    expect(() => createUnsubscribe({ ...options, address: '  ' })).toThrow(/address/);
  });

  it('captures validated configuration so subsequent caller mutation cannot change generated URLs', () => {
    const mutable: UnsubscribeOptions = { ...options, from: 'hello@example.com' };
    const unsub = createUnsubscribe(mutable);
    mutable.baseUrl = 'https://attacker.example';
    mutable.from = 'hello@attacker.example';
    mutable.address = 'Attacker address';
    mutable.confirmPath = '/different/:token';
    const decorated = unsub.decorate({ list: 'newsletter', email: 'alice@example.com' });
    expect(decorated.unsubscribeUrl).toMatch(/^https:\/\/mail\.example\.com\/unsubscribe\//);
    expect(decorated.headers['List-Unsubscribe']).toContain('mailto:unsubscribe@example.com?');
    expect(decorated.footer.text).toContain(options.address);
  });

  it.each(['/u/:token', '/u/:token/confirm', '/u?token=:token', '/u?source=email&token=:token&lang=en'])('handles its configured token placement: %s', async (oneClickPath) => {
    const unsub = createUnsubscribe({ ...options, oneClickPath });
    const onUnsubscribe = vi.fn();
    const token = unsub.mint({ list: 'newsletter', email: 'alice@example.com' });
    const response = await unsub.handler(onUnsubscribe)(new Request(unsub.urls(token).oneClick, { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(onUnsubscribe).toHaveBeenCalledWith(expect.objectContaining({ email: 'alice@example.com' }), expect.anything());
  });

  it('only extracts tokens from the configured path unless a custom extractor is given', async () => {
    const unsub = createUnsubscribe(options);
    const token = unsub.mint({ list: 'newsletter', email: 'alice@example.com' });
    const request = new Request(`https://mail.example.com/unrelated/${token}`, { method: 'POST' });
    const onUnsubscribe = vi.fn();
    expect((await unsub.handler(onUnsubscribe)(request)).status).toBe(400);
    expect(onUnsubscribe).not.toHaveBeenCalled();
    expect((await unsub.handler(onUnsubscribe, { tokenFrom: () => token })(request)).status).toBe(200);
  });
});
