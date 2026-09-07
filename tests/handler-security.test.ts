import { describe, expect, it, vi } from 'vitest';
import { createUnsubscribe, createOneClickHandler, defaultTokenFrom } from '../src/index.js';
import { MAX_BODY_BYTES } from '../src/handler.js';
import { expressOneClick } from '../src/express.js';

const unsub = createUnsubscribe({ secret: 'a-random-test-secret-at-least-32-characters', baseUrl: 'https://mail.example.com' });
const token = unsub.mint({ list: 'news', email: 'test@example.com' });
const url = unsub.urls(token).oneClick;

function streaming(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  return new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    duplex: 'half', ...(signal ? { signal } : {}),
  } as RequestInit);
}

function responseMock() {
  const result = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown };
  const res = {
    status(code: number) { result.status = code; return res; },
    set(name: string, value: string) { result.headers[name] = value; return res; },
    send(body?: unknown) { result.body = body; },
    end() {},
  };
  return { res, result };
}

describe('bounded form inspection', () => {
  it.each([0, 1])('enforces the cumulative byte cap across chunks with %s excess byte(s)', async (excess) => {
    const prefix = 'List-Unsubscribe=One-Click&padding=';
    const bytes = new TextEncoder().encode(prefix + 'x'.repeat(MAX_BODY_BYTES - prefix.length + excess));
    const callback = vi.fn();
    const cancel = vi.fn();
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) {
          if (!excess) controller.close();
          return;
        }
        const end = Math.min(offset + 17, bytes.length);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
      cancel,
    });
    const response = await unsub.handler(callback)(streaming(body));
    expect(response.status).toBe(200);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]![1].oneClick).toBe(excess === 0);
    expect(body.locked).toBe(false);
    if (excess) expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds empty chunks without retaining promises or starving the event loop', async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const callback = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array()); }, cancel,
    });
    expect((await unsub.handler(callback)(streaming(body))).status).toBe(200);
    expect(pulls).toBeLessThanOrEqual(66);
    expect(cancel).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]![1].oneClick).toBe(false);
  });

  it('finishes a stalled stream even when cancellation never resolves', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const callback = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull() {}, cancel });
    const response = await unsub.handler(callback, { bodyTimeoutMs: 15 })(streaming(body));
    expect(response.status).toBe(200);
    expect(callback.mock.calls[0]![1].oneClick).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('stops reading at the byte cap without waiting for EOF or cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const callback = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_BODY_BYTES + 1)); }, cancel,
    });
    const response = await unsub.handler(callback)(streaming(body));
    expect(response.status).toBe(200);
    expect(callback.mock.calls[0]![1].oneClick).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('contains locked and errored bodies', async () => {
    for (const state of ['locked', 'errored']) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) { if (state === 'errored') controller.error(new Error('stream failed')); },
      });
      const request = streaming(body);
      const reader = state === 'locked' ? request.body!.getReader() : undefined;
      const callback = vi.fn();
      expect((await unsub.handler(callback)(request)).status).toBe(200);
      expect(callback.mock.calls[0]![1].oneClick).toBe(false);
      reader?.releaseLock();
    }
  });

  it('handles an abort without waiting for the body deadline', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const callback = vi.fn();
    const response = unsub.handler(callback)(streaming(new ReadableStream({ cancel }), controller.signal));
    controller.abort();
    expect((await response).status).toBe(200);
    expect(callback.mock.calls[0]![1].oneClick).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([0, -1, NaN, Infinity, 0.5, 2_147_483_648])('rejects invalid timeout %s at construction', (bodyTimeoutMs) => {
    expect(() => unsub.handler(vi.fn(), { bodyTimeoutMs })).toThrow(/bodyTimeoutMs/);
  });

  it.each([
    ['Application/X-Www-Form-Urlencoded; charset=UTF-8', true],
    ['text/plain; note=application/x-www-form-urlencoded', false],
    ['application/x-www-form-urlencoded-evil', false],
    ['multipart/form-data', false],
  ])('parses the media type exactly: %s', async (type, expected) => {
    const callback = vi.fn();
    const response = await unsub.handler(callback)(new Request(url, {
      method: 'POST', headers: { 'content-type': type }, body: 'List-Unsubscribe=One-Click',
    }));
    expect(response.status).toBe(200);
    expect(callback.mock.calls[0]![1].oneClick).toBe(expected);
  });
});

describe('response boundaries', () => {
  it.each(['POST', 'PUT'])('cancels an unread body on an early %s rejection', async (method) => {
    const callback = vi.fn();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const request = new Request('https://mail.example.com/unsubscribe/invalid', {
      method, body, duplex: 'half',
    } as RequestInit);
    const response = await unsub.handler(callback)(request);
    expect(response.status).toBe(method === 'POST' ? 400 : 405);
    expect(cancel).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
  });

  it('escapes signed recipient text in the confirm page without running the callback', async () => {
    const callback = vi.fn();
    const email = '<svg/onload="alert(1)">&example@example.com';
    const signed = unsub.mint({ list: 'news', email });
    const response = await unsub.handler(callback)(new Request(unsub.urls(signed).oneClick));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('&lt;svg/onload=&quot;alert(1)&quot;>&amp;example@example.com');
    expect(html).not.toContain('<svg');
    expect(callback).not.toHaveBeenCalled();
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('waits for suppression to complete and ignores a returned redirect response', async () => {
    let complete!: () => void;
    const committed = new Promise<void>((resolve) => { complete = resolve; });
    const callback = vi.fn(async () => {
      await committed;
      return Response.redirect('https://example.com/after-unsubscribe', 302);
    });
    let responded = false;
    const pending = unsub.handler(callback)(new Request(url, { method: 'POST' }))
      .then((response) => { responded = true; return response; });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    expect(responded).toBe(false);
    complete();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.text()).toBe('');
  });

  it('extracts a query token ahead of an arbitrary endpoint name', () => {
    expect(defaultTokenFrom(new Request(`https://mail.example.com/unsubscribe?token=${token}`))).toBe(token);
    expect(defaultTokenFrom(new Request(`${url}?token=`))).toBe('');
  });

  it('advertises only enabled methods without attempting token verification', async () => {
    const verify = vi.fn();
    const handler = createOneClickHandler({ codec: { mint: vi.fn(), verify }, onUnsubscribe: vi.fn() });
    for (const method of ['GET', 'HEAD', 'DELETE', 'OPTIONS']) {
      const response = await handler(new Request(url, { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it('prevents caching, referrer disclosure, framing, and content sniffing', async () => {
    const handler = unsub.handler(vi.fn());
    for (const request of [new Request(url), new Request(url, { method: 'POST' }), new Request('https://mail.example.com/unsubscribe/invalid')]) {
      const response = await handler(request);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toContain("form-action 'self'");
    }
  });

  it('reports callback, extractor, and renderer failures without exposing details', async () => {
    const failure = new Error('database secret');
    const throws = () => { throw failure; };
    for (const options of [{}, { tokenFrom: throws }, { confirmPage: throws }]) {
      const onError = vi.fn(async () => { throw new Error('logger failed'); });
      const response = await unsub.handler(throws, { ...options, onError })(new Request(url, {
        method: 'confirmPage' in options ? 'GET' : 'POST',
      }));
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('server error');
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    }
  });
});

describe('Express boundaries', () => {
  it.each(['//evil.example/u', '/\\evil/u', 'https://evil.example/u', '/u\r\nHeader:value', '/u#fragment'])('contains unsafe request target %j on POST', async (path) => {
    const callback = vi.fn();
    const { res, result } = responseMock();
    await expressOneClick(unsub.codec, callback)({ method: 'POST', url: path, params: { token }, headers: {} }, res);
    expect(result.status).toBe(400);
    expect(callback).not.toHaveBeenCalled();
  });

  it('reports rejected callbacks and throwing renderers, with privacy headers', async () => {
    const failure = new Error('private failure');
    const onError = vi.fn(async () => { throw new Error('logger failed'); });
    for (const method of ['POST', 'GET']) {
      const { res, result } = responseMock();
      await expressOneClick(unsub.codec, async () => { throw failure; }, {
        confirmPage: () => { throw failure; }, onError,
      })({ method, url: `/u/${token}`, headers: {} }, res);
      expect(result.status).toBe(500);
      expect(result.body).toBe('server error');
      expect(result.headers['referrer-policy']).toBe('no-referrer');
    }
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('ignores inherited form fields and rejects array route params', async () => {
    const callback = vi.fn();
    const { res, result } = responseMock();
    await expressOneClick(unsub.codec, callback)({ method: 'POST', url: `/u/${token}`, headers: {}, body: Object.create({ 'List-Unsubscribe': 'One-Click' }) }, res);
    expect(result.status).toBe(200);
    expect(callback.mock.calls[0]![1].oneClick).toBe(false);
    await expressOneClick(unsub.codec, callback)({ method: 'POST', url: `/u/${token}`, params: { token: [token] }, headers: {} }, res);
    expect(result.status).toBe(400);
    expect(callback).toHaveBeenCalledOnce();
  });
});
