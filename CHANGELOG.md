# Changelog

## 0.1.1 — 2026-09-07

- Publish under the Lickgrass organization scope as `@lickgrass/one-click-unsub`.
- Update installation instructions and package checks for the scoped name.
  Replace the previous `one-click-unsub` dependency and import paths when upgrading.
- No changes to the public API, implementation, or token format.

## 0.1.0 — 2026-09-07

Initial public release:

- Require supported Node.js versions; see the package engine range.
- Reject injected mail headers, unsafe URLs, oversized/noncanonical tokens,
  ambiguous purpose labels, and invalid TTL/expiry values.
- Bound Fetch body inspection by bytes, time, and empty chunks; contain stream
  failures and custom hook failures; add privacy headers and error observation.
- Validate origin/path configuration, preserve configured token placement, and
  snapshot configuration at construction.
- Preserve canonical token signatures; see OPERATIONS.md for migration changes.
- Add actual Express HTTP tests, installed-tarball checks, and reproducible benchmarks.

- Stateless HMAC-SHA256 unsubscribe tokens, configurable expiry, purpose labels,
  and signing-key rotation.
- RFC 8058 and RFC 2369 headers, HTTPS unsubscribe URLs, and escaped HTML/text
  footers with a postal address.
- Fetch and Express handlers with confirmation pages and idempotent suppression
  callbacks.
- ESM, CommonJS, and TypeScript entry points with no runtime dependencies.
- Security and contributor guidance, dependency updates, and CI checks of tests,
  types, builds, package entry points, and known dependency advisories.
