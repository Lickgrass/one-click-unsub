import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUnsubscribe, type UnsubscribeContext, type UnsubscribePayload } from '../src/index.js';
import { expressOneClick } from '../src/express.js';

const unsub = createUnsubscribe({
  secret: 'integration-test-secret-at-least-thirty-two-bytes-long',
  baseUrl: 'https://mail.example.com',
});
const token = unsub.mint({ list: 'newsletter', email: 'alice@example.com' });
const onUnsubscribe = vi.fn(async (_payload: UnsubscribePayload, _context: UnsubscribeContext) => {});
const onError = vi.fn();
const routeEntered = vi.fn();
const databaseError = new Error('private database error');
let server: Server | undefined;
let origin: string;

function expectPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  expect(response.headers.get('content-security-policy')).toContain("form-action 'self'");
}

describe('real Express integration', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false, limit: '16kb' }));
    const router = express.Router();
    // This assignment is also a compile-time check against Express's actual types.
    const middleware: RequestHandler = expressOneClick(unsub.codec, onUnsubscribe, { confirmPage: true });
    router.all('/unsubscribe/:token', (_req, _res, next) => { routeEntered(); next(); }, middleware);
    router.all('/failure/:token', expressOneClick(unsub.codec, async () => { throw databaseError; }, { onError }));
    app.use('/mail', router);
    // Parser/router errors belong to the host app, before the adapter runs.
    const errorHandler: ErrorRequestHandler = (error: { status?: number }, _req, res, _next) => {
      res.status(error.status ?? 500).send('request rejected');
    };
    app.use(errorHandler);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => { server!.off('error', reject); resolve(); });
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => { vi.clearAllMocks(); });

  afterAll(async () => {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
      server!.closeAllConnections();
    });
  });

  it('serves a private confirmation page under a mounted router without unsubscribing', async () => {
    const response = await fetch(`${origin}/mail/unsubscribe/${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expectPrivate(response);
    const html = await response.text();
    expect(html).toContain('<form method="post">');
    expect(html).toContain('alice@example.com');
    expect(html).not.toMatch(/<form[^>]*\baction=/);
    expect(onUnsubscribe).not.toHaveBeenCalled();
  });

  it('parses a real urlencoded POST and passes the mounted path in the synthetic request', async () => {
    const response = await fetch(`${origin}/mail/unsubscribe/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-host': 'attacker.example' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('location')).toBeNull();
    expectPrivate(response);
    expect(onUnsubscribe).toHaveBeenCalledTimes(1);
    const [payload, context] = onUnsubscribe.mock.calls[0]!;
    expect(payload).toMatchObject({ list: 'newsletter', email: 'alice@example.com' });
    expect(context.oneClick).toBe(true);
    expect(context.request.url).toBe(`http://local/mail/unsubscribe/${token}`);
    expect(context.request.headers.get('x-forwarded-host')).toBeNull();
  });

  it('recognizes the human confirmation form as oneClick=false', async () => {
    const response = await fetch(`${origin}/mail/unsubscribe/${token}`, {
      method: 'POST', body: new URLSearchParams({ confirm: '1' }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(onUnsubscribe.mock.calls[0]![1].oneClick).toBe(false);
  });

  it('rejects invalid tokens and malformed route escapes without invoking callbacks', async () => {
    const invalid = await fetch(`${origin}/mail/unsubscribe/not-a-token`, { method: 'POST' });
    expect(invalid.status).toBe(400);
    expectPrivate(invalid);
    expect(await invalid.text()).toBe('invalid token');
    const malformed = await fetch(`${origin}/mail/unsubscribe/%E0`, { method: 'POST' });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).toBe('request rejected');
    expect(onUnsubscribe).not.toHaveBeenCalled();
  });

  it('advertises supported methods when rejecting an unsupported request', async () => {
    const response = await fetch(`${origin}/mail/unsubscribe/${token}`, { method: 'DELETE' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST, GET');
    expectPrivate(response);
    expect(await response.text()).toBe('method not allowed');
    expect(onUnsubscribe).not.toHaveBeenCalled();
  });

  it('contains async callback failures and reports them through onError', async () => {
    const response = await fetch(`${origin}/mail/failure/${token}`, { method: 'POST' });
    expect(response.status).toBe(500);
    expectPrivate(response);
    expect(await response.text()).toBe('server error');
    expect(onError).toHaveBeenCalledExactlyOnceWith(databaseError);
  });

  it('uses the host parser limit to reject oversized bodies before entering the adapter', async () => {
    const response = await fetch(`${origin}/mail/unsubscribe/${token}`, {
      method: 'POST',
      body: new URLSearchParams({ 'List-Unsubscribe': 'One-Click', padding: 'x'.repeat(20_000) }),
    });
    expect(response.status).toBe(413);
    expect(await response.text()).toBe('request rejected');
    expect(routeEntered).not.toHaveBeenCalled();
    expect(onUnsubscribe).not.toHaveBeenCalled();
  });
});
