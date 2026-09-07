# Production operations and release

This is a stateless library, not a hosted service. Production readiness depends
on the application's suppression store, sender integration, mail authentication,
and hosting configuration. The automated checks here validate the library and
published package; they cannot certify your deployment or promise no vulnerabilities.

## Before processing real email

1. **Persist suppression before returning success.** Use an indexed unique key
   such as `(tenant, list, normalized_email)` with an atomic insert/upsert. Map
   each list to the right tenant when issuing tokens. Every sender/queue worker
   must check the suppression state just before delivery. Test concurrent and
   repeated POSTs, store failures, queue retries, and already queued messages.
   Choose the suppression scope required for your marketing and opt-out policy.
2. **Manage secrets and old links.** Generate at least 32 random bytes and encode
   them as hex/base64; store the resulting string in a secret manager. Use separate
   keys per environment/application. Deploy old verification keys before switching
   the issuing key, then retain them for the longest outstanding token lifetime.
   Up to 64 previous keys are accepted; fewer keys reduce verification cost.
   Removing a compromised key invalidates every token it signed. There is no
   per-token revocation. Keep clocks synchronized and avoid short link lifetimes.
3. **Protect the endpoint.** Use HTTPS and a fully patched supported Node LTS.
   Set proxy/server body, request-header, URL, read-timeout, connection, and
   concurrency limits. The Fetch handler caps retained body bytes at 16 KiB and
   inspection at 5 seconds (`bodyTimeoutMs`); this does not bound your host's own
   buffers, open sockets, or database work. Set database and `onError` deadlines.
   Configure route-local Express body parsers with limits; compressed bodies
   should be rejected or bounded before decompression. A parser's 413/415 response
   occurs before the adapter. Accept normal urlencoded and multipart receiver
   POSTs without login, CAPTCHA, cookies, or redirects.
4. **Keep bearer URLs private.** Tokens encode addresses and list identifiers in
   readable base64url. Redact full paths/query tokens in CDN, proxy, application,
   tracing, analytics, and error logs. The handler sets no-store, no-referrer,
   nosniff, anti-framing, and a restrictive CSP on every response. Do not add
   third-party scripts/resources. Escape interpolations in custom confirmation
   renderers; the policy allows inline styles and same-origin form posts only.
5. **Verify real delivery.** Send a test message through your actual provider and
   inspect its raw headers. DKIM must cover both List-Unsubscribe headers; use
   the public HTTPS URL directly without redirects. Confirm mailer folding of
   long combined header values between URI entries; each individual bracketed
   URI is capped at 980 characters. Use short list identifiers. If `from` enables
   a mailto fallback, operate that mailbox and verify the token from the body
   before recording the same durable suppression. Exercise manual GET→POST and
   receiver POST flows end-to-end. Review [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.html),
   [Gmail requirements](https://support.google.com/mail/answer/81126), and the
   [FTC guidance](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)
   as applicable; adding this package does not satisfy every sending requirement.
6. **Observe outcomes.** Monitor callback failures, persisted suppressions,
   request latency, rejected tokens, request volume, DB pool saturation, and
   retries. `oneClick` is a form-shape hint, not requester identity. HTTP 200 means
   the callback resolved; it says nothing about storage durability unless the
   callback enforces it. Verify alerts with a controlled store failure before launch.

## Performance validation

Run `npm run bench` on a supported runtime. `BENCH_ITERATIONS=20000` is the default;
valid values are 1000–100000. The script records runtime/platform/architecture,
workload size, warmup, five samples, and median throughput plus amortized operation
latency. It checks return values and includes valid, forged, oversized, and rotated-key
tokens, full message decoration, and sequential Fetch POST handling.

A local reference run is recorded in
[benchmarks/node24-2026-09-06.json](benchmarks/node24-2026-09-06.json).
On Node 24.20.0 / Apple M4 Pro it measured median 106,307 valid verifications/s
with one key and 47,337 in-memory Fetch POSTs/s. With 64 previous keys, verification
was 1,866/s; retain only the keys your outstanding links need.

These are CPU/allocation microbenchmarks with synthetic identities and an in-memory
callback. They exclude TLS, network concurrency, Express/proxy parsing, real databases,
mail delivery, and cold starts. They are not capacity targets or percentile request
latencies. Record repeated runs on the same hardware/runtime before evaluating a
performance change; shared CI timings are not reliable regression thresholds.

For deployment load tests, use synthetic recipients against the real suppression
store. Measure p50/p95/p99 latency, RSS/heap, event-loop delay, connection and DB pool
usage at expected peak traffic and bursts. Include concurrent duplicate callbacks,
invalid/maximum-sized tokens, multipart bodies, slow clients, maximum configured
key rotation, and store outages/recovery. Define capacity/error targets from your
traffic and alerting requirements before deciding the deployment is ready.

## Release checks

Use the Node version in `package.json` and run from a clean checkout:

```sh
npm ci --ignore-scripts
npm run check
npm audit --package-lock-only --audit-level=low
npm run bench
npm pack --dry-run
```

`check` typechecks, runs regression and real Express tests, builds declarations and
ESM/CJS, then installs an actual tarball into a temporary clean consumer. It tests
both public entry points and NodeNext/legacy TypeScript resolution. The tarball
must contain only built files and approved documentation, with zero runtime dependencies.
`prepack` rebuilds output; `prepublishOnly` repeats all checks. Do not bypass these
hooks when publishing. Network-free tarball validation uses `--ignore-scripts`
internally after the build to prevent recursive lifecycle execution.

The `esbuild` development override selects the patched 0.28 line because current
build tools constrain it to 0.27. It addresses
[GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr).
Build and package checks exercise the override. Remove it when upstream constraints
accept a fixed version, after repeating clean-install and package checks.

Before the first public release, the maintainer must complete these account-level
steps. They are not configured by files in this repository:

- Enable private vulnerability reporting and verify the reporter entry point.
- Protect `main` with reviews and all CI checks; enable secret scanning/push
  protection and dependency security alerts where available.
- Verify ownership/availability of the npm package name, enable publishing 2FA,
  and review package contents/version/changelog. Prefer
  [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) with provenance
  after configuring the exact repository and workflow identity. No publishing
  workflow or stored npm token is supplied here.
- Run the hosted Node 22.12/22/24/26 Linux and Node 24 Windows/macOS CI matrix and dependency audit successfully,
  then publish the reviewed version and test installation from the registry.
  Record the release notes and tag the exact source used for the package.

## Compatibility changes in launch hardening

Node 18/20 are no longer supported; use the engine range in `package.json`.
Previously issued canonical tokens for supported purpose labels retain their
signatures. Invalid TTL/clock values, ambiguous purpose labels, noncanonical token
encodings, oversized tokens, and identities with control characters are rejected.

`baseUrl` must be an origin; move any mount prefix to `oneClickPath`/`confirmPath`.
Templates require exactly one `:token`, start with a single slash, and reject dot
segments, fragments, unsafe URI characters, and malformed percent escapes. Headers
and footers require valid HTTPS links without credentials. Direct mailto header
values are validated, and individual URI values are length bounded. Factory options
are captured at construction. Custom renderers now run under the documented CSP.
Review these checks if migrating an unpublished checkout or early integration.
