import { describe, expect, it, vi } from 'vitest';
import { createUnsubscribe } from '../src/index.js';
import { expressOneClick } from '../src/express.js';

const SECRET = 'unit-test-secret-at-least-thirty-two-bytes-long';
const unsub = createUnsubscribe({
  secret: SECRET,
  baseUrl: 'https://mail.example.com',
  address: 'Acme Inc, 123 Main St',
  from: 'hello@acme.com',
});

function post(url: string, body?: string, type = 'application/x-www-form-urlencoded') {
  return body === undefined
    ? new Request(url, { method: 'POST' })
    : new Request(url, { method: 'POST', headers: { 'content-type': type }, body });
}

describe('decorate', () => {
  it('produces token, headers, footer, and the confirm url', () => {
    const d = unsub.decorate({ list: 'newsletter', email: 'alice@example.com' });
    expect(unsub.verify(d.token)!.email).toBe('alice@example.com');
    expect(d.headers['List-Unsubscribe']).toMatch(
      /^<https:\/\/mail\.example\.com\/unsubscribe\/.+>, <mailto:unsubscribe@acme\.com\?.+>$/,
    );
    expect(d.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(d.footer.text).toContain(d.unsubscribeUrl);
    expect(d.unsubscribeUrl).toBe(unsub.urls(d.token).confirm);
  });

  it('refuses a non-https baseUrl at construction', () => {
    expect(() => createUnsubscribe({ secret: SECRET, baseUrl: 'http://localhost:3000' })).toThrow(/https/);
  });

  it('refuses without a physical address', () => {
    const bare = createUnsubscribe({ secret: SECRET, baseUrl: 'https://x' });
    expect(() => bare.decorate({ list: 'l', email: 'a@b.co' })).toThrow(/address/);
  });
});

describe('fetch handler', () => {
  it('unsubscribes on a valid one-click POST and answers 200 with no body', async () => {
    const onUnsubscribe = vi.fn();
    const handle = unsub.handler(onUnsubscribe);
    const { token } = unsub.decorate({ list: 'newsletter', email: 'alice@example.com' });
    const res = await handle(post(unsub.urls(token).oneClick, 'List-Unsubscribe=One-Click'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(onUnsubscribe).toHaveBeenCalledTimes(1);
    const [payload, ctx] = onUnsubscribe.mock.calls[0]!;
    expect(payload).toMatchObject({ list: 'newsletter', email: 'alice@example.com' });
    expect(ctx.oneClick).toBe(true);
  });

  it('flags oneClick=false for a POST without the RFC 8058 body (a human on the confirm page)', async () => {
    const onUnsubscribe = vi.fn();
    const handle = unsub.handler(onUnsubscribe);
    const { token } = unsub.decorate({ list: 'l', email: 'a@b.co' });
    const res = await handle(post(unsub.urls(token).oneClick));
    expect(res.status).toBe(200);
    expect(onUnsubscribe.mock.calls[0]![1].oneClick).toBe(false);
  });

  it('rejects a forged token with 400 and never calls back', async () => {
    const onUnsubscribe = vi.fn();
    const handle = unsub.handler(onUnsubscribe);
    const res = await handle(post('https://mail.example.com/unsubscribe/not.a-token', 'List-Unsubscribe=One-Click'));
    expect(res.status).toBe(400);
    expect(onUnsubscribe).not.toHaveBeenCalled();
  });

  it('GET serves the confirm page by default (the footer link points here); off → 405', async () => {
    const { token } = unsub.decorate({ list: 'l', email: 'a@b.co' });
    const url = unsub.urls(token).oneClick;
    const res = await unsub.handler(vi.fn())(new Request(url));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form method="post"');
    expect(html).toContain('a@b.co');
    // The page's form is NOT the RFC 8058 body, and it has NO action: it
    // posts to the URL it was served at, prefix and all, echoing nothing.
    expect(html).toContain('name="confirm" value="1"');
    expect(html).not.toContain('List-Unsubscribe');
    expect(html).toContain('<form method="post">');
    expect(html).not.toMatch(/<form[^>]*\baction=/);
    expect(html).not.toContain('https://mail.example.com');
    const strict = unsub.handler(vi.fn(), { confirmPage: false });
    expect((await strict(new Request(url))).status).toBe(405);
  });

  it('a person submitting the confirm page reads as oneClick=false', async () => {
    const onUnsubscribe = vi.fn();
    const { token } = unsub.decorate({ list: 'l', email: 'a@b.co' });
    const res = await unsub.handler(onUnsubscribe)(post(unsub.urls(token).oneClick, 'confirm=1'));
    expect(res.status).toBe(200);
    expect(onUnsubscribe.mock.calls[0]![1].oneClick).toBe(false);
  });

  it('recognizes the RFC 8058 multipart/form-data shape as oneClick=true', async () => {
    const onUnsubscribe = vi.fn();
    const { token } = unsub.decorate({ list: 'l', email: 'a@b.co' });
    const fd = new FormData();
    fd.set('List-Unsubscribe', 'One-Click');
    const res = await unsub.handler(onUnsubscribe)(new Request(unsub.urls(token).oneClick, { method: 'POST', body: fd }));
    expect(res.status).toBe(200);
    expect(onUnsubscribe.mock.calls[0]![1].oneClick).toBe(true);
  });

  it('a body past the 16 KB cap is never buffered: still 200, but oneClick=false', async () => {
    const onUnsubscribe = vi.fn();
    const { token } = unsub.decorate({ list: 'l', email: 'a@b.co' });
    const big = 'List-Unsubscribe=One-Click&pad=' + 'x'.repeat(40_000);
    const res = await unsub.handler(onUnsubscribe)(post(unsub.urls(token).oneClick, big));
    expect(res.status).toBe(200);
    expect(onUnsubscribe.mock.calls[0]![1].oneClick).toBe(false);
  });

  it('a "//host" pathname never reaches a confirm-page renderer', async () => {
    const { token } = unsub.decorate({ list: 'l', email: 'a@b.co' });
    const renderer = vi.fn(() => '<p>custom</p>');
    const res = await unsub.handler(vi.fn(), { confirmPage: renderer })(
      new Request(`https://mail.example.com//evil.example/unsubscribe/${encodeURIComponent(token)}`),
    );
    expect(res.status).toBe(400);
    expect(renderer).not.toHaveBeenCalled();
  });

  it('refuses a baseUrl carrying CR/LF or angle brackets (header injection)', () => {
    expect(() => createUnsubscribe({ secret: SECRET, baseUrl: 'https://mail.example.com/\r\nBcc: x@evil' })).toThrow(/whitespace/);
    expect(() => createUnsubscribe({ secret: SECRET, baseUrl: 'https://mail.example.com/>' })).toThrow(/angle/);
  });

  it('refuses a path without the :token placeholder', () => {
    expect(() => createUnsubscribe({ secret: SECRET, baseUrl: 'https://x', oneClickPath: '/unsubscribe' })).toThrow(/:token/);
    expect(() => createUnsubscribe({ secret: SECRET, baseUrl: 'https://x', confirmPath: '/u' })).toThrow(/:token/);
  });

  it('a malformed %-escape in the path is a 400, not a thrown URIError', async () => {
    const onUnsubscribe = vi.fn();
    const res = await unsub.handler(onUnsubscribe)(post('https://mail.example.com/unsubscribe/%E0', 'List-Unsubscribe=One-Click'));
    expect(res.status).toBe(400);
    expect(onUnsubscribe).not.toHaveBeenCalled();
  });

  it('accepts a callback that returns a value (an ORM upsert result)', async () => {
    const { token } = unsub.decorate({ list: 'l', email: 'a@b.co' });
    const handle = unsub.handler(async () => ({ id: 1 }));
    expect((await handle(post(unsub.urls(token).oneClick, 'List-Unsubscribe=One-Click'))).status).toBe(200);
  });

  it('answers 500 when the callback throws', async () => {
    const handle = unsub.handler(() => {
      throw new Error('db down');
    });
    const { token } = unsub.decorate({ list: 'l', email: 'a@b.co' });
    expect((await handle(post(unsub.urls(token).oneClick, 'List-Unsubscribe=One-Click'))).status).toBe(500);
  });

  it('refuses other methods', async () => {
    const handle = unsub.handler(vi.fn());
    const { token } = unsub.decorate({ list: 'l', email: 'a@b.co' });
    expect((await handle(new Request(unsub.urls(token).oneClick, { method: 'DELETE' }))).status).toBe(405);
  });
});

describe('express adapter', () => {
  function res() {
    const r: Record<string, unknown> & { code?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
    const api = {
      status(c: number) { r.code = c; return api; },
      set(n: string, v: string) { r.headers[n] = v; return api; },
      send(b?: unknown) { r.body = b; },
      end() { r.body = undefined; },
    };
    return { api, r };
  }

  it('POST with the parsed form body unsubscribes', async () => {
    const onUnsubscribe = vi.fn();
    const mw = expressOneClick(unsub.codec, onUnsubscribe);
    const { token } = unsub.decorate({ list: 'l', email: 'a@b.co' });
    const { api, r } = res();
    await mw({ method: 'POST', url: `/unsubscribe/${encodeURIComponent(token)}`, headers: {}, params: { token }, body: { 'List-Unsubscribe': 'One-Click' } }, api);
    expect(r.code).toBe(200);
    expect(onUnsubscribe.mock.calls[0]![1].oneClick).toBe(true);
  });

  it('bad token is 400; a malformed escape in the URL fallback is 400 too', async () => {
    const mw = expressOneClick(unsub.codec, vi.fn());
    const { api, r } = res();
    await mw({ method: 'POST', url: '/unsubscribe/nope', headers: {}, params: { token: 'nope' } }, api);
    expect(r.code).toBe(400);
    const { api: api2, r: r2 } = res();
    await mw({ method: 'POST', url: '/unsubscribe/%E0', headers: {} }, api2);
    expect(r2.code).toBe(400);
  });

  it('GET confirm page under a mounted Router has no form action and never echoes the host', async () => {
    const mw = expressOneClick(unsub.codec, vi.fn(), { confirmPage: true });
    const { token } = unsub.decorate({ list: 'l', email: 'a@b.co' });
    const t = encodeURIComponent(token);
    const { api, r } = res();
    await mw({ method: 'GET', url: `/${t}`, originalUrl: `/optout/${t}`, headers: { host: 'evil.example' }, params: { token } }, api);
    expect(r.code).toBe(200);
    expect(String(r.body)).toContain('<form method="post">');
    expect(String(r.body)).not.toMatch(/<form[^>]*\baction=/);
    expect(String(r.body)).not.toContain('evil.example');
  });

  it('custom renderers get the mount-prefixed path; a "//" request-target is refused', async () => {
    const renderer = vi.fn((_p, path: string) => `<i>${path}</i>`);
    const mw = expressOneClick(unsub.codec, vi.fn(), { confirmPage: renderer });
    const { token } = unsub.decorate({ list: 'l', email: 'a@b.co' });
    const t = encodeURIComponent(token);
    const { api, r } = res();
    await mw({ method: 'GET', url: `/${t}`, originalUrl: `/optout/${t}`, headers: {}, params: { token } }, api);
    expect(String(r.body)).toBe(`<i>/optout/${t}</i>`);
    const { api: api2, r: r2 } = res();
    await mw({ method: 'GET', url: `//evil.example/${t}`, headers: {}, params: { token } }, api2);
    expect(r2.code).toBe(400);
  });
});
