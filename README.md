# @lickgrass/one-click-unsub

RFC 8058 one-click unsubscribe for people who send their own mail. HMAC
signed tokens, `List-Unsubscribe` headers, Fetch and Express handlers, and
HTML/text footers. Zero runtime dependencies, ESM and CommonJS, with TypeScript
declarations. Supports Node.js 22 (22.12+), 24, and 26+; use a fully patched LTS release.

This library builds the unsubscribe flow. Your application supplies durable
suppression storage and checks that storage before sending again. Your mail
provider supplies DKIM. Review [Gmail's sender guidelines](https://support.google.com/mail/answer/81126)
and your other receivers' requirements when configuring your mail service.

See [production setup](OPERATIONS.md), [security policy](SECURITY.md), and
[contributing](CONTRIBUTING.md). This package does not certify delivery,
regulatory compliance, or an enterprise support SLA.

```sh
npm install @lickgrass/one-click-unsub
```

Previously installed `one-click-unsub`? Replace that dependency with
`@lickgrass/one-click-unsub` and update your import paths, including `/express`.
The API and token format are unchanged.

## The five-minute version

```ts
import { createUnsubscribe } from '@lickgrass/one-click-unsub';

const unsub = createUnsubscribe({
  secret: process.env.UNSUB_SECRET!,       // random secret; generate as shown below
  baseUrl: 'https://mail.example.com',     // where the handler is mounted (must be https)
  address: 'Acme Inc, 123 Main St, San Francisco CA 94103',
  // Optional: only add from if you process the unsubscribe@ mailbox.
  // from: 'hello@acme.com',
});

// 1. On every marketing send:
const d = unsub.decorate({ list: 'newsletter', email: to });
await ses.send({
  to,
  headers: d.headers,                       // List-Unsubscribe + List-Unsubscribe-Post
  text: body.text + d.footer.text,          // visible link + your postal address
  html: body.html + d.footer.html,
});

// 2. One route, mounted at baseUrl + '/unsubscribe/:token':
const handle = unsub.handler(({ list, email }) => db.suppress({ list, email })); // must be idempotent
export const POST = handle;                 // mail clients POST here (RFC 8058)
export const GET = handle;                  // people land here from the footer: a confirm page
```

That's a Next.js route handler; mount it at `app/unsubscribe/[token]/route.ts`
using the Node runtime. The adapter accepts a standard `(Request) => Promise<Response>`.
For Hono, unwrap its context with `(c) => handle(c.req.raw)`.
Bun, Deno, and Cloudflare Workers integrations should be verified in your deployment;
CI currently tests Node and Express. Workers needs Node compatibility for `node:crypto`
and `node:buffer`; see [Cloudflare's compatibility documentation](https://developers.cloudflare.com/workers/runtime-apis/nodejs/).

Express:

```ts
import { expressOneClick } from '@lickgrass/one-click-unsub/express';
// The adapter reads req.body. urlencoded covers Gmail's documented POST; RFC 8058 §3.2
// also allows multipart/form-data, so mount a multipart parser too if you want
// ctx.oneClick for those — without one the unsubscribe still runs, but oneClick reads false.
app.use('/unsubscribe', express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 32, inflate: false }));
app.post('/unsubscribe/:token', expressOneClick(unsub.codec, (p) => db.suppress(p)));
app.get('/unsubscribe/:token', expressOneClick(unsub.codec, (p) => db.suppress(p), { confirmPage: true }));
```

## What it does, exactly

**Tokens.** `payload.tag`, where payload is `base64url(JSON({ l: list, e: email, x: expiresAt }))`
and tag is HMAC-SHA256 under a key derived as `sha256("unsubscribe:" + secret)`.
Stateless: no token table to grow or expire. Signature comparisons use
`timingSafeEqual` across every accepted key; overall verification time depends
on input length and configured key count. Tokens are signed, **not encrypted**:
the payload reveals the email address and list. Treat the whole URL as a bearer
credential and redact it from logs and analytics.
Default lifetime is one year, because the link in an archived email has to
keep working. `previousSecrets` (up to 64) lets you rotate without breaking links
already in inboxes. The `purpose` label separates domains, so a token
minted for something else (a double-opt-in confirm, say) can never be
replayed against the unsubscribe endpoint even with a shared secret. Labels
must be 1–128 ASCII letters, digits, dots, underscores, or hyphens. Tokens are
limited to 8,192 characters before verification; email header limits are lower.
`ttlMs` must be a positive safe integer and is floored at one minute. Choose a
lifetime that meets your operational and regulatory requirements.

**Headers.** `List-Unsubscribe: <https://…/unsubscribe/TOKEN>, <mailto:unsubscribe@acme.com?…>`
per RFC 2369 and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` per
RFC 8058. The RFC requires the one-click URI to be https, so `baseUrl`
must be an HTTPS origin with no credentials, path, query, or fragment, and
`createUnsubscribe` throws otherwise; the URL only
appears in the header, so use your public origin even when developing
locally. The mailto lands on your From: domain because that is inbound
mail you already control; route `unsubscribe@` there and read the token
out of the body. Omit `from` if you do not operate this mailbox. Each bracketed URI is capped
at 980 ASCII characters so it fits on an email header line. Your mailer must
fold long combined headers between URI values; do not split inside a URI.

**Handler.** Mail receivers POST the form field
`List-Unsubscribe=One-Click` (RFC 8058 §3.2, multipart or urlencoded;
multipart detection uses `Response.formData()`)
and the sender unsubscribes with no further interaction; the RFC's one
response rule is no redirects, and this answers 200 with an empty body.
Form inspection retains at most 16 KiB and waits at most 5 seconds by default.
Oversized, unreadable, aborted, or slow bodies yield `oneClick: false`; a valid
token still invokes the callback. `bodyTimeoutMs` changes the inspection deadline.
This bounds library parsing, not data already buffered by your server or proxy. The token in the URL is the credential; mail
clients send no cookies, so there is no CSRF check and you must not put
one in front of it. Forged, expired, or malformed token: 400, and your
callback is never called. GET serves a minimal confirm page by default,
because the visible footer link points at the same URL; it's a plain form
with no action attribute, so it posts back to exactly the URL it was
served at (an Express mount prefix included), and it deliberately does not
send the RFC field. `ctx.oneClick` reports whether the POST carried the
RFC 8058 field, the shape mail clients send and the confirm page does not.
It is a hint about the request's shape, not proof of who sent it: the
token is the only credential, and anyone holding it can send either shape
(RFC 8058 §6), so don't build audit labels or policy on it as attribution.
All responses include `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, anti-framing headers, and a CSP that permits
inline styles and same-origin forms but no scripts or external resources.
Custom renderers must fit this policy and HTML-escape their interpolated values.
Pass `confirmPage: false` for 405 on GET (if you host your own page at a
separate `confirmPath`, that's the default), or pass your own renderer.

**Footer.** A visible HTTPS unsubscribe link and your physical postal address,
in plain text and escaped HTML. `decorate` requires an address. A footer alone
does not establish CAN-SPAM compliance; review the
[FTC's guidance](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business),
including opt-out scope, processing deadlines, and how long links must work.

## Three things to know

- **DKIM must cover the two headers.** RFC 8058 §4: the message needs a
  valid DKIM signature whose `h=` tag includes `List-Unsubscribe` and
  `List-Unsubscribe-Post`, or receivers should not offer one-click at
  all. This package writes the headers; your signer has to sign them.
  Check the `h=` tag of a sent message once.
- **Separate marketing suppression from essential account messages.** Call
  `decorate` for marketing/subscription sends. Classify mixed-purpose messages
  using your applicable rules; do not assume every account message is exempt.
- **Your callback must be idempotent.** Mail clients may POST twice.
  Suppressing an already-suppressed address should be a no-op.

## Configuration and errors

Generate a secret once, store it in a secret manager, and share it across the
sender and handler instances. Do not generate a new key on each restart:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Paths are root-relative templates with exactly one `:token`, no fragment or dot
segments. Put a proxy prefix in the path, not `baseUrl`:

```ts
const unsub = createUnsubscribe({
  secret: process.env.UNSUB_SECRET!,
  previousSecrets: [],
  baseUrl: 'https://mail.example.com',
  oneClickPath: '/email/unsubscribe/:token',
});

const handle = unsub.handler(async ({ list, email }) => {
  await db.suppress({ list, email }); // resolve only after durable persistence
}, {
  bodyTimeoutMs: 5000,
  onError: (error) => logger.error({ error }, 'unsubscribe failed'),
});
```

Set database and logger deadlines in the application. `onError` receives failures
from the callback, token extractor, or renderer; clients get a generic 500.
The hook is awaited and its own errors are contained. Redact sensitive data from
errors before logging. Express accepts the same `onError` option; its
`ctx.request` is a synthetic request with a local origin, method, and path, without
original headers/body. Configure Express parser limits before the adapter.

The factory extracts the token using `oneClickPath`, including query or non-final
path placement. `createOneClickHandler` alone uses a `token` query parameter if
present, otherwise the last path segment. Override `tokenFrom` when routing or
proxy rewrites require it. A distinct `confirmPath` requires your own GET route.

## Validation and performance

```sh
npm ci --ignore-scripts
npm run check
npm audit --package-lock-only --audit-level=low
npm run bench
```

Checks cover token tampering, malformed inputs, request resource limits, HTML and
header injection, actual Express requests, and clean tarball installation with
ESM/CommonJS and TypeScript consumers. The benchmark uses synthetic recipients and
an in-memory callback; it does not measure TLS, databases, or deployed throughput.
See [OPERATIONS.md](OPERATIONS.md) for production load testing and release steps.

## Built by Lickgrass

Created by [Lickgrass](https://lickgrass.com).

## License

MIT
