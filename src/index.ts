import { createTokenCodec, DEFAULT_TTL_MS, type TokenCodec, type TokenCodecOptions, type UnsubscribePayload } from './token.js';
import { assertHttps, buildListHeaders, unsubscribeMailto, LIST_UNSUBSCRIBE_POST, type ListHeaders } from './headers.js';
import { renderFooter, stampFooter, type Footer, type FooterInput } from './footer.js';
import { createOneClickHandler, defaultConfirmPage, defaultTokenFrom, type HandlerOptions, type UnsubscribeContext } from './handler.js';

export {
  createTokenCodec,
  DEFAULT_TTL_MS,
  buildListHeaders,
  unsubscribeMailto,
  LIST_UNSUBSCRIBE_POST,
  renderFooter,
  stampFooter,
  createOneClickHandler,
  defaultConfirmPage,
  defaultTokenFrom,
};
export type { TokenCodec, TokenCodecOptions, UnsubscribePayload, ListHeaders, Footer, FooterInput, HandlerOptions, UnsubscribeContext };

export interface UnsubscribeOptions extends TokenCodecOptions {
  /** Absolute https origin where the handler is mounted, e.g.
   *  https://mail.example.com. RFC 8058 requires https; this throws otherwise. */
  baseUrl: string;
  /** Root-relative path of the POST target; contains exactly one ':token'
   *  in the path or query, replaced with the signed token. The URI is the
   *  only context a mail client's POST carries. No fragments or dot
   *  segments. Default '/unsubscribe/:token'. */
  oneClickPath?: string | undefined;
  /** Root-relative path of the human confirm page, if you serve your own; must contain
   *  exactly one ':token'. Default: the oneClickPath, and then `handler()` serves the
   *  confirm page on GET. */
  confirmPath?: string | undefined;
  /** Your physical mailing address for the CAN-SPAM footer. */
  address?: string | undefined;
  /** From: address (display names fine) or domain, for the mailto fallback. */
  from?: string | undefined;
}

export interface Unsubscribe {
  mint: TokenCodec['mint'];
  verify: TokenCodec['verify'];
  /** Absolute URLs for a token. */
  urls(token: string): { oneClick: string; confirm: string; mailto: string | undefined };
  /** Everything a marketing send needs: token, headers, footer. */
  decorate(input: { list: string; email: string; ttlMs?: number | undefined; reason?: string | undefined }): {
    token: string;
    headers: ListHeaders;
    footer: Footer;
    unsubscribeUrl: string;
  };
  /** Fetch-style POST/GET handler for the one-click URL. The confirm
   *  page is ON by default when the footer's link points here (no
   *  separate confirmPath), so the visible link never answers 405. */
  handler(
    onUnsubscribe: HandlerOptions['onUnsubscribe'],
    options?: Omit<HandlerOptions, 'codec' | 'onUnsubscribe'>,
  ): (request: Request) => Promise<Response>;
  codec: TokenCodec;
}

function assertPath(path: string, what: string): void {
  if (typeof path !== 'string' || path.split(':token').length !== 2) {
    throw new Error(
      `one-click-unsub: ${what} must contain exactly one ':token' — the URI is the only context a mail client's POST carries (RFC 8058 §3.1)`,
    );
  }
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(`one-click-unsub: ${what} must start with a single '/'`);
  }
  const probe = `https://validation.invalid${path}`;
  assertHttps(probe, what);
  const parsed = new URL(probe);
  if (`${parsed.pathname}${parsed.search}` !== path) {
    throw new Error(`one-click-unsub: ${what} must not contain dot segments or other parts normalized by URL parsing`);
  }
}

function join(base: string, path: string, token: string): string {
  return `${base}${path.replace(':token', encodeURIComponent(token))}`;
}

/** Match the configured URI, including a token in a query or non-final
 * path segment. A caller can still provide its own tokenFrom hook. */
function tokenFromPath(path: string): NonNullable<HandlerOptions['tokenFrom']> {
  const offset = path.indexOf(':token');
  const prefix = path.slice(0, offset);
  const suffix = path.slice(offset + ':token'.length);
  return (request) => {
    const url = new URL(request.url);
    const target = `${url.pathname}${url.search}`;
    if (!target.startsWith(prefix) || !target.endsWith(suffix) || target.length <= prefix.length + suffix.length) return null;
    try {
      return decodeURIComponent(target.slice(prefix.length, target.length - suffix.length));
    } catch {
      return null;
    }
  };
}

/**
 * The batteries-included entry point. One object holds the secret, the
 * URLs, the address, and the From domain; every send calls `decorate`.
 */
export function createUnsubscribe(options: UnsubscribeOptions): Unsubscribe {
  // Fail at boot, not on the first send: the one-click URL only ever
  // appears in a header, so it can be https even on a local dev server.
  assertHttps(options.baseUrl, 'baseUrl');
  const parsedBase = new URL(options.baseUrl);
  if (!/^https:\/\/[^/?#]+\/?$/i.test(options.baseUrl)) {
    throw new Error('one-click-unsub: baseUrl must be an https origin without a path, query, or fragment; put paths in oneClickPath or confirmPath');
  }
  const baseUrl = parsedBase.origin;
  const codec = createTokenCodec(options);
  const oneClickPath = options.oneClickPath ?? '/unsubscribe/:token';
  assertPath(oneClickPath, 'oneClickPath');
  const confirmPath = options.confirmPath ?? oneClickPath;
  if (confirmPath !== oneClickPath) assertPath(confirmPath, 'confirmPath');
  const tokenFrom = tokenFromPath(oneClickPath);
  const address = options.address?.trim();
  if (address !== undefined && !address) throw new Error('one-click-unsub: a physical mailing address must not be empty');
  const mailtoPrefix = options.from !== undefined ? unsubscribeMailto(options.from, '') : undefined;
  const urls = (token: string) => {
    if (typeof token !== 'string' || !token || token === '.' || token === '..') {
      throw new Error('one-click-unsub: token must be a non-empty string other than a URL dot segment');
    }
    return {
      oneClick: join(baseUrl, oneClickPath, token),
      confirm: join(baseUrl, confirmPath, token),
      mailto: mailtoPrefix === undefined ? undefined : `${mailtoPrefix}${encodeURIComponent(token)}`,
    };
  };
  return {
    codec,
    mint: codec.mint,
    verify: codec.verify,
    urls,
    decorate({ list, email, ttlMs, reason }) {
      if (!address) {
        throw new Error('one-click-unsub: `address` is required to decorate a marketing send (CAN-SPAM)');
      }
      const token = codec.mint(ttlMs === undefined ? { list, email } : { list, email, ttlMs });
      const u = urls(token);
      const footerInput: FooterInput = { unsubscribeUrl: u.confirm, address };
      if (reason !== undefined) footerInput.reason = reason;
      return {
        token,
        headers: buildListHeaders({ oneClickUrl: u.oneClick, mailto: u.mailto }),
        footer: renderFooter(footerInput),
        unsubscribeUrl: u.confirm,
      };
    },
    handler(onUnsubscribe, handlerOptions = {}) {
      const confirmPage = handlerOptions.confirmPage ?? (confirmPath === oneClickPath);
      return createOneClickHandler({ codec, onUnsubscribe, ...handlerOptions, tokenFrom: handlerOptions.tokenFrom ?? tokenFrom, confirmPage });
    },
  };
}
