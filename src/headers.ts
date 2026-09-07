/**
 * The two headers that make one-click unsubscribe work.
 *
 * RFC 2369  List-Unsubscribe: <https://…>, <mailto:…>
 * RFC 8058  List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * Gmail and Yahoo require both on bulk mail (their 2024 sender
 * requirements: Yahoo's List-Unsubscribe enforcement from June 2024,
 * Gmail's one-click deadline June 1, 2024). The https URL is what mail clients POST to —
 * the RFC says it MUST be https. The mailto is a fallback some receivers
 * still prefer; its host is your From: domain because that is inbound
 * mail you already control.
 */
export const LIST_UNSUBSCRIBE_POST = 'List-Unsubscribe=One-Click';

/** A type alias (not an interface) so it assigns to the
 *  `Record<string, string>` header maps nodemailer, Resend, and SES take. */
export type ListHeaders = {
  'List-Unsubscribe': string;
  'List-Unsubscribe-Post': typeof LIST_UNSUBSCRIBE_POST;
};

/** RFC 5322 §2.2: a header field body is printable US-ASCII + WSP with
 *  CR/LF only as folding; RFC 2369 §2 wraps the URL in <>, so those can't
 *  appear inside it. `new URL()` strips tab/CR/LF and percent-encodes
 *  before parsing, so the parsed string is not the string we emit —
 *  check the RAW string, and reject rather than silently rewrite. */
const URL_UNSAFE = /[^\x21-\x7e]|[<>"\\^`{|}]|%(?![\da-f]{2})/i;

export function assertHttps(url: string, what: string): void {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    /* not a URL */
  }
  if (
    typeof url !== 'string' ||
    !/^https:\/\/[^/?#]/i.test(url) ||
    !parsed || parsed.protocol !== 'https:' || !parsed.hostname ||
    parsed.username || parsed.password || /^https:\/\/[^/?#]*@/i.test(url) ||
    url.includes('#') || URL_UNSAFE.test(url)
  ) {
    throw new Error(
      `one-click-unsub: ${what} must be an absolute https:// URL with no credentials, fragment, whitespace, control characters, angle brackets, or invalid URL escapes (RFC 8058 §3.1, RFC 5322 §2.2)`,
    );
  }
}

function assertMailto(url: string): void {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    /* not a URL */
  }
  if (
    typeof url !== 'string' || !parsed || parsed.protocol !== 'mailto:' ||
    !parsed.pathname || parsed.host || parsed.pathname.startsWith('//') ||
    url.includes('#') || URL_UNSAFE.test(url)
  ) {
    throw new Error('one-click-unsub: mailto must be a mailto: URL with a recipient and no whitespace, control characters, angle brackets, or invalid URL escapes');
  }
}

/** Each <URI> fits the RFC 5322 998-character line limit, including the
 * field name. When the combined value is longer, the sending mailer must
 * fold between URLs at the comma and space; never fold inside a URI. */
export function buildListHeaders(input: { oneClickUrl: string; mailto?: string | undefined }): ListHeaders {
  assertHttps(input.oneClickUrl, 'oneClickUrl');
  const parts = [`<${input.oneClickUrl}>`];
  if (input.mailto !== undefined) {
    assertMailto(input.mailto);
    parts.push(`<${input.mailto}>`);
  }
  const maxPartLength = 998 - 'List-Unsubscribe: '.length;
  if (parts.some((part) => part.length > maxPartLength)) {
    throw new Error('one-click-unsub: each List-Unsubscribe URI must fit the 998-character mail header line limit; shorten the URL or token identifiers');
  }
  return {
    'List-Unsubscribe': parts.join(', '),
    'List-Unsubscribe-Post': LIST_UNSUBSCRIBE_POST,
  };
}

/** `mailto:unsubscribe@<domain>?subject=unsubscribe&body=<token>` — the
 *  token rides the body for receivers that can't do plus-addressing. */
export function unsubscribeMailto(fromAddressOrDomain: string, token: string): string {
  // Accept "Acme <hello@acme.com>", "hello@acme.com", or "acme.com".
  const m = /^(?:[^<>]*<([^<>]+)>|([^<>]+))$/.exec(fromAddressOrDomain.trim());
  const addr = (m?.[1] ?? m?.[2] ?? '').trim();
  const domain = addr.replace(/^.*@/, '').trim();
  if (
    /[\x00-\x1f\x7f]/.test(fromAddressOrDomain) || domain.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(domain)
  ) {
    throw new Error('one-click-unsub: cannot derive a valid mailto domain from the From address');
  }
  return `mailto:unsubscribe@${domain}?subject=unsubscribe&body=${encodeURIComponent(token)}`;
}
