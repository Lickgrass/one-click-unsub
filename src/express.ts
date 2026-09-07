/**
 * Express adapter for the one-click handler. Mount on the same path
 * your List-Unsubscribe URL points at:
 *
 *   app.post('/unsubscribe/:token', expressOneClick(unsub, (p) => db.suppress(p)))
 *   app.get('/unsubscribe/:token',  expressOneClick(unsub, ..., { confirmPage: true }))
 *
 * Mount `express.urlencoded({ extended: false })` (and a multipart
 * parser if you want `ctx.oneClick` for multipart posts) ahead of it —
 * the adapter reads `req.body` and never touches the raw stream.
 *
 * Typed loosely on purpose so Express is not a dependency of this
 * package; any (req, res) pair with these fields works.
 */
import type { HandlerOptions, UnsubscribeContext } from './handler.js';
import { defaultConfirmPage, defaultTokenFrom, reportError, RESPONSE_HEADERS, MAX_BODY_BYTES } from './handler.js';

interface ReqLike {
  method: string;
  url: string;
  /** Express keeps the mount prefix here; `url` is mount-relative inside a Router. */
  originalUrl?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string | string[] | undefined> | undefined;
  body?: unknown;
}
interface ResLike {
  status(code: number): ResLike;
  set(name: string, value: string): ResLike;
  send(body?: unknown): unknown;
  end(): unknown;
}

export function expressOneClick(
  codec: HandlerOptions['codec'],
  onUnsubscribe: HandlerOptions['onUnsubscribe'],
  options: Pick<HandlerOptions, 'confirmPage' | 'onError'> = {},
): (req: ReqLike, res: ResLike) => Promise<void> {
  const allow = options.confirmPage ? 'POST, GET' : 'POST';
  return async (req, res) => {
    for (const [name, value] of Object.entries(RESPONSE_HEADERS)) res.set(name, value);
    try {
      const method = req.method.toUpperCase();
      if (method !== 'POST' && !(method === 'GET' && options.confirmPage)) {
        res.status(405).set('allow', allow).send('method not allowed');
        return;
      }
      // Keep a Router's mount prefix, but never trust Host/forwarded headers.
      const url = req.originalUrl ?? req.url;
      if (!url.startsWith('/') || /^\/[\/\\]/.test(url) || /[\\\x00-\x20\x7f#]/.test(url)) {
        res.status(400).send('invalid path');
        return;
      }
      const request = new Request(`http://local${url}`, { method });
      // Express has already decoded params. The fallback handles path/query tokens.
      const raw = req.params?.token ?? defaultTokenFrom(request);
      const payload = codec.verify(typeof raw === 'string' ? raw : null);
      if (!payload) {
        res.status(400).send('invalid token');
        return;
      }
      if (method === 'GET') {
        const render = typeof options.confirmPage === 'function' ? options.confirmPage : defaultConfirmPage;
        const html = render(payload, url);
        res.status(200).set('content-type', 'text/html; charset=utf-8').send(html);
        return;
      }
      const body = req.body;
      const oneClick =
        (typeof body === 'object' && body !== null && Object.hasOwn(body, 'List-Unsubscribe') &&
          (body as Record<string, unknown>)['List-Unsubscribe'] === 'One-Click') ||
        (typeof body === 'string' && body.length <= MAX_BODY_BYTES &&
          new URLSearchParams(body).get('List-Unsubscribe') === 'One-Click');
      const ctx: UnsubscribeContext = {
        oneClick,
        // A synthetic Request: local origin, no original headers/body or socket metadata.
        request,
      };
      await onUnsubscribe(payload, ctx);
      res.status(200).end();
    } catch (error) {
      await reportError(error, options.onError);
      res.status(500).send('server error');
    }
  };
}
