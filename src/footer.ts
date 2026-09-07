/**
 * The CAN-SPAM footer: a visible unsubscribe link and the sender's
 * physical postal address (15 U.S.C. §7704(a)(5)(A)(iii); what counts is
 * defined at 16 CFR §316.2(p)). Plain text and HTML.
 *
 * The address goes AFTER the link so the link sits above the fold of
 * most preview panes. User-supplied address text is HTML-escaped.
 */
import { assertHttps } from './headers.js';

export interface Footer {
  text: string;
  html: string;
}

export interface FooterInput {
  /** Absolute HTTPS URL without credentials or a fragment (a page with a confirm button,
   *  or the one-click URL itself if you don't have a page). */
  unsubscribeUrl: string;
  /** Your physical mailing address. Newlines become <br> in HTML. */
  address: string;
  /** Why they're getting this. Default: "You're receiving this because you signed up." */
  reason?: string | undefined;
}

const DEFAULT_REASON = "You're receiving this because you signed up.";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderFooter(input: FooterInput): Footer {
  // HTML escaping alone does not make a javascript: or data: URL safe.
  assertHttps(input.unsubscribeUrl, 'unsubscribeUrl');
  const address = input.address.trim();
  if (!address) throw new Error('one-click-unsub: a physical mailing address is required (CAN-SPAM)');
  const reason = input.reason ?? DEFAULT_REASON;
  const text = `\n\n— — —\n${reason} Unsubscribe: ${input.unsubscribeUrl}\n\n${address}\n`;
  const html =
    `<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0">` +
    `<div style="color:#666;font-size:12px;line-height:1.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">` +
    `${escapeHtml(reason)} <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#666;text-decoration:underline">Unsubscribe</a>.` +
    `<br><br>${escapeHtml(address).replace(/\r\n|\r|\n/g, '<br>')}</div>`;
  return { text, html };
}

/** Append the footer to whichever bodies exist; absent halves stay absent. */
export function stampFooter(
  bodies: { text?: string | undefined; html?: string | undefined },
  footer: Footer,
): { text: string | undefined; html: string | undefined } {
  return {
    text: bodies.text !== undefined ? `${bodies.text}${footer.text}` : undefined,
    html: bodies.html !== undefined ? `${bodies.html}${footer.html}` : undefined,
  };
}
