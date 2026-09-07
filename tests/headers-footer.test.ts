import { describe, expect, it } from 'vitest';
import { buildListHeaders, unsubscribeMailto } from '../src/headers.js';
import { renderFooter, stampFooter } from '../src/footer.js';

describe('headers', () => {
  it('renders RFC 2369 + RFC 8058 headers with https and mailto', () => {
    const h = buildListHeaders({
      oneClickUrl: 'https://mail.example.com/unsubscribe/abc',
      mailto: unsubscribeMailto('noreply@acme.com', 'abc'),
    });
    expect(h['List-Unsubscribe']).toBe(
      '<https://mail.example.com/unsubscribe/abc>, <mailto:unsubscribe@acme.com?subject=unsubscribe&body=abc>',
    );
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('omits mailto when none is given', () => {
    const h = buildListHeaders({ oneClickUrl: 'https://x/u/abc' });
    expect(h['List-Unsubscribe']).toBe('<https://x/u/abc>');
  });

  it('derives the mailto host from a full address, a display-name From:, or a bare domain', () => {
    expect(unsubscribeMailto('hello@acme.com', 't')).toContain('unsubscribe@acme.com');
    expect(unsubscribeMailto('acme.com', 't')).toContain('unsubscribe@acme.com');
    expect(unsubscribeMailto('Acme <hello@acme.com>', 't')).toBe('mailto:unsubscribe@acme.com?subject=unsubscribe&body=t');
    expect(unsubscribeMailto('"Acme, Inc." <hello@acme.com>', 't')).toContain('unsubscribe@acme.com?');
    expect(unsubscribeMailto('  Acme <hello@acme.com>  ', 't')).toContain('unsubscribe@acme.com?');
    expect(() => unsubscribeMailto('hello@acme.com>', 't')).toThrow(/mailto domain/);
  });

  it('refuses a non-https one-click URL (RFC 8058 §3.1)', () => {
    expect(() => buildListHeaders({ oneClickUrl: 'http://localhost:3000/unsubscribe/abc' })).toThrow(/https/);
    expect(() => buildListHeaders({ oneClickUrl: 'not a url' })).toThrow(/https/);
  });

  it.each([
    'mailto:unsubscribe@example.com>\r\nBcc: victim@example.com',
    'mailto:unsubscribe@example.com>, <https://evil.example',
    'mailto:unsubscribe@example.com\n',
    'mailto:unsubscribe@exa\tmple.com',
    'https://example.com/extra-unsubscribe',
    'javascript:alert(1)',
    'mailto:',
    'mailto://example.com/path',
    'mailto:unsubscribe@example.com#ignored',
    'mailto:unsubscribe@example.com?body=%ZZ',
    '',
  ])('rejects an unsafe or non-mailto fallback: %j', (mailto) => {
    expect(() => buildListHeaders({ oneClickUrl: 'https://x/u/t', mailto })).toThrow(/mailto/);
  });

  it.each([
    'https://example.com/u/t\r\nBcc: victim@example.com',
    'https://example.com/u/<token>',
    'https://example.com/u/"quoted"',
    'https://user:password@example.com/u/t',
    'https://@example.com/u/t',
    'https://example.com/u#token',
    'https:example.com/u/t',
    'https:///example.com/u/t',
    'https://example.com\\u\\t',
    'https://example.com/u/%ZZ',
  ])('rejects unsafe or ambiguous HTTPS URLs: %j', (oneClickUrl) => {
    expect(() => buildListHeaders({ oneClickUrl })).toThrow(/https/);
  });

  it('does not expose a token or URL credentials in validation errors', () => {
    let message = '';
    try {
      buildListHeaders({ oneClickUrl: 'https://secret-password@example.com/private-token' });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/one-click-unsub:/);
    expect(message).not.toContain('secret-password');
    expect(message).not.toContain('private-token');
  });

  it('percent-encodes mailto token content instead of adding mail headers or query fields', () => {
    const mailto = unsubscribeMailto('example.com', 'a\r\nBcc: victim@example.com&subject=other');
    const headers = buildListHeaders({ oneClickUrl: 'https://x/u/t', mailto });
    expect(headers['List-Unsubscribe']).not.toMatch(/[\r\n]/);
    expect(mailto).toContain('body=a%0D%0ABcc%3A%20victim%40example.com%26subject%3Dother');
  });

  it('bounds each URI to fit a mail header line while allowing the mailer to fold between URLs', () => {
    const prefix = 'https://example.com/u/';
    const oneClickUrl = prefix + 't'.repeat(978 - prefix.length);
    const mailto = 'mailto:unsubscribe@example.com?body=' + 't'.repeat(600);
    const headers = buildListHeaders({ oneClickUrl, mailto });
    expect(headers['List-Unsubscribe'].length).toBeGreaterThan(980);
    expect(headers['List-Unsubscribe'].split(', ')[0]!.length + 'List-Unsubscribe: '.length).toBe(998);
    expect(() => buildListHeaders({ oneClickUrl: `${oneClickUrl}t` })).toThrow(/line limit/);
    expect(() => buildListHeaders({ oneClickUrl, mailto: `${mailto}${'t'.repeat(500)}` })).toThrow(/line limit/);
  });

  it.each(['..', '-example.com', 'example-.com', 'example..com', `${'x'.repeat(64)}.com`, 'Acme <a@example.com> injected', 'Acme\r\nBcc: x <a@example.com>'])('rejects invalid fallback domains: %j', (from) => {
    expect(() => unsubscribeMailto(from, 'token')).toThrow(/mailto domain/);
  });
});

describe('footer', () => {
  it('includes the link and the address in both bodies; newlines become <br>', () => {
    const f = renderFooter({ unsubscribeUrl: 'https://x/u/t', address: 'Acme Inc\n123 Main St\nSan Francisco' });
    expect(f.text).toContain('Unsubscribe: https://x/u/t');
    expect(f.text).toContain('Acme Inc');
    expect(f.html).toContain('href="https://x/u/t"');
    expect(f.html).toContain('<br>123 Main St');
  });

  it('html-escapes the address', () => {
    const f = renderFooter({ unsubscribeUrl: 'https://x/u/t', address: '<script>alert(1)</script>' });
    expect(f.html).not.toContain('<script>');
    expect(f.html).toContain('&lt;script&gt;');
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '//evil.example/u', 'https://x/u/\n'])('rejects unsafe footer links: %j', (unsubscribeUrl) => {
    expect(() => renderFooter({ unsubscribeUrl, address: 'Acme' })).toThrow(/unsubscribeUrl/);
  });

  it('escapes the reason and URL attribute, and handles all postal address newline styles', () => {
    const footer = renderFooter({
      unsubscribeUrl: 'https://example.com/u/t?reason=a&other=b',
      address: 'Acme\r\n123 Main\rSuite 4\nCity',
      reason: '<img src=x onerror="alert(1)">',
    });
    expect(footer.html).toContain('href="https://example.com/u/t?reason=a&amp;other=b"');
    expect(footer.html).not.toContain('<img');
    expect(footer.html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(footer.html).toContain('Acme<br>123 Main<br>Suite 4<br>City');
  });

  it('refuses an empty address', () => {
    expect(() => renderFooter({ unsubscribeUrl: 'https://x', address: '  ' })).toThrow(/address/);
  });

  it('stamps only the bodies that exist', () => {
    const f = renderFooter({ unsubscribeUrl: 'https://x/u/t', address: 'Acme' });
    const out = stampFooter({ html: '<p>hi</p>' }, f);
    expect(out.text).toBeUndefined();
    expect(out.html!.startsWith('<p>hi</p>')).toBe(true);
    expect(out.html).toContain('Unsubscribe');
  });
});
