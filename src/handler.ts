/**
 * The RFC 8058 POST target as a fetch-style handler — works anywhere a
 * `(Request) => Promise<Response>` does: Next.js route handlers, Bun,
 * Deno, Cloudflare Workers (Hono via `c.req.raw`). Express gets its own
 * adapter.
 *
 * What the RFC asks of the server: mail receivers POST the form field
 * `List-Unsubscribe=One-Click` (§3.2 — as multipart/form-data, or
 * urlencoded) and the sender performs the unsubscribe with no further
 * interaction. The RFC's one response rule is "no redirects" (§3.1);
 * answering 200 with an empty body is what Gmail's example expects.
 * The token in the URL is the whole credential — mail clients send no
 * cookies — so there is no CSRF layer here and there must not be one
 * in front of it.
 */
import type { TokenCodec, UnsubscribePayload } from './token.js';

export interface UnsubscribeContext {
  /** True when the POST body carried the RFC 8058 form field
   *  `List-Unsubscribe=One-Click` (multipart or urlencoded) — the shape
   *  mail clients send; the shipped confirm page deliberately sends a
   *  different field. A hint about the request's SHAPE, not attribution:
   *  the token is the only credential and anyone holding it can send
   *  either shape (RFC 8058 §6). */
  oneClick: boolean;
  request: Request;
}

export interface HandlerOptions {
  codec: TokenCodec;
  /** Do the unsubscribe. Must be idempotent — mail clients may POST
   *  twice. Throwing yields a 500. The return value is ignored. */
  onUnsubscribe: (payload: UnsubscribePayload, ctx: UnsubscribeContext) => unknown;
  /** How to find the token. Default: the `token` query param when present,
   *  otherwise the last path segment. */
  tokenFrom?: ((request: Request) => string | null) | undefined;
  /** Serve a GET with a minimal confirm page (a form that POSTs to the
   *  same path). When off, GET answers 405 so a link preview can't
   *  unsubscribe anyone. `createUnsubscribe().handler` turns it on by
   *  default when the footer's confirm link points at this handler. */
  confirmPage?: boolean | ((payload: UnsubscribePayload, postPath: string) => string) | undefined;
  /** Maximum time to inspect the form body, in ms. Default 5000. An
   *  oversized, unreadable, or slow body still unsubscribes with oneClick=false. */
  bodyTimeoutMs?: number | undefined;
  /** Observe callback, token extractor, or renderer failures. Do not log
   *  raw requests/tokens. Errors from this hook are contained as well. */
  onError?: ((error: unknown) => unknown) | undefined;
}

export function defaultTokenFrom(request: Request): string | null {
  const url = new URL(request.url);
  if (url.searchParams.has('token')) return url.searchParams.get('token');
  const last = url.pathname.split('/').filter(Boolean).pop();
  if (last) {
    try {
      return decodeURIComponent(last);
    } catch {
      return null; // malformed %-escape → treated as an invalid token (400)
    }
  }
  return null;
}

/** The form carries NO action attribute, so the browser posts it to the
 *  URL the page was served at (HTML: an empty action means the form
 *  document's URL) — an Express mount prefix or a proxy path prefix
 *  included — and the page never echoes a Host header or a path it can't
 *  trust. `postPath` stays in the renderer contract for custom pages. It
 *  sends `confirm=1`, not the RFC 8058 field, so the callback can
 *  distinguish the two request shapes. */
export function defaultConfirmPage(payload: UnsubscribePayload, _postPath: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return (
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>Unsubscribe</title>` +
    `<main style="font-family:system-ui,sans-serif;max-width:32em;margin:4rem auto;padding:0 1rem">` +
    `<h1 style="font-size:1.25rem">Unsubscribe ${esc(payload.email)}?</h1>` +
    `<p>You'll stop receiving this mailing list.</p>` +
    `<form method="post">` +
    `<input type="hidden" name="confirm" value="1">` +
    `<button type="submit" style="font:inherit;padding:.6em 1.2em">Unsubscribe</button>` +
    `</form></main>`
  );
}

/** The RFC 8058 body is 26 bytes urlencoded and a few hundred as
 *  multipart. The host may not bound the stream before parsing, so any
 *  body past this reads as
 *  oneClick=false and the stream is cancelled without retaining excess bytes. */
export const MAX_BODY_BYTES = 16 * 1024;

const DEFAULT_BODY_TIMEOUT_MS = 5000;

/** Shared privacy policy for pages and error responses carrying bearer URLs. */
export const RESPONSE_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

export async function reportError(error: unknown, onError: HandlerOptions['onError']): Promise<void> {
  try {
    await onError?.(error);
  } catch {
    // An observability failure must not expose an exception to the caller.
  }
}

/** Bound retained bytes AND elapsed read time, including never-ending streams.
 * Cancellation is best-effort: an uncooperative producer must not delay the response. */
async function readCapped(request: Request, timeoutMs: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array();
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const stop = new Promise<null>((resolve) => {
    abort = () => resolve(null);
    timer = setTimeout(abort, timeoutMs);
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
  });
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let size = 0;
  let complete = false;
  const deadline = performance.now() + timeoutMs;
  const collect = async () => {
    let emptyChunks = 0;
    for (;;) {
      if (performance.now() >= deadline || request.signal.aborted) return null;
      const result = await reader.read();
      if (result.done) {
        complete = true;
        return bytes.subarray(0, size);
      }
      // Empty chunks cannot spend an unlimited number of microtasks without
      // advancing the byte budget or allowing timers/socket work to run.
      if (result.value.byteLength === 0 && ++emptyChunks > 64) return null;
      if (result.value.byteLength > MAX_BODY_BYTES - size) return null;
      bytes.set(result.value, size);
      size += result.value.byteLength;
    }
  };
  try {
    // Race once: per-chunk races retain reactions on the pending timer promise.
    return await Promise.race([collect(), stop]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (abort) request.signal.removeEventListener('abort', abort);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function cancelBody(request: Request): void {
  if (request.body && !request.body.locked) void request.body.cancel().catch(() => {});
}

/** RFC 8058 supports both multipart and urlencoded forms. Inspect only a
 * bounded body; the form is a shape hint and the token is the credential. */
async function bodySaysOneClick(request: Request, timeoutMs: number): Promise<boolean> {
  const type = request.headers.get('content-type') ?? '';
  const mediaType = type.split(';', 1)[0]!.trim().toLowerCase();
  if ((mediaType !== 'application/x-www-form-urlencoded' && mediaType !== 'multipart/form-data') ||
      Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    cancelBody(request);
    return false;
  }
  const bytes = await readCapped(request, timeoutMs);
  if (bytes === null) return false;
  try {
    // URLSearchParams avoids building a second Request for the common case.
    if (mediaType === 'application/x-www-form-urlencoded') {
      return new URLSearchParams(new TextDecoder().decode(bytes)).get('List-Unsubscribe') === 'One-Click';
    }
    const bounded = new Response(new Blob([bytes]), { headers: { 'content-type': type } });
    return (await bounded.formData()).get('List-Unsubscribe') === 'One-Click';
  } catch {
    return false;
  }
}

/** Path + query for custom confirm-page renderers, or null when the
 *  pathname opens with "//": WHATWG keeps that (and turns "\" into "/"),
 *  and in an attribute it is a protocol-relative URL, not a path on this
 *  origin. */
function pathOf(url: string): string | null {
  const u = new URL(url);
  if (u.pathname.startsWith('//')) return null;
  return `${u.pathname}${u.search}`;
}

export function createOneClickHandler(options: HandlerOptions): (request: Request) => Promise<Response> {
  const tokenFrom = options.tokenFrom ?? defaultTokenFrom;
  const timeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error('one-click-unsub: bodyTimeoutMs must be a positive integer no greater than 2147483647');
  }
  const allow = options.confirmPage ? 'POST, GET' : 'POST';
  const respond = (body: string | null, status: number, headers: Record<string, string> = {}) =>
    new Response(body, { status, headers: { ...RESPONSE_HEADERS, ...headers } });
  return async (request) => {
    try {
      const method = request.method.toUpperCase();
      if (method !== 'POST' && !(method === 'GET' && options.confirmPage)) {
        return respond('method not allowed', 405, { allow });
      }
      const payload = options.codec.verify(tokenFrom(request));
      if (!payload) return respond('invalid token', 400);

      if (method === 'GET') {
        const postPath = pathOf(request.url);
        if (postPath === null) return respond('invalid path', 400);
        const render = typeof options.confirmPage === 'function' ? options.confirmPage : defaultConfirmPage;
        return respond(render(payload, postPath), 200, { 'content-type': 'text/html; charset=utf-8' });
      }

      const oneClick = await bodySaysOneClick(request, timeoutMs);
      await options.onUnsubscribe(payload, { oneClick, request });
      // 200, empty body, no redirect (RFC 8058 §3.1 forbids redirects).
      return respond(null, 200);
    } catch (error) {
      await reportError(error, options.onError);
      return respond('server error', 500);
    } finally {
      cancelBody(request);
    }
  };
}
