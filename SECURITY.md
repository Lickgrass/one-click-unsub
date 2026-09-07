# Security policy

## Supported versions

Security fixes target the latest published release. Upgrade to the latest release
when reporting a problem; older releases do not have a separate backport policy.
Use a supported, fully patched Node.js LTS version that satisfies `package.json`.

## Reporting a vulnerability

Do not put exploit details, production tokens, signing keys, or recipient data in
public issues or pull requests.

Open this repository on GitHub, select **Security**, and use **Report a
vulnerability** if that option is available. If private reporting is unavailable,
open an issue saying only that you need a private security reporting channel and
wait for the maintainers to arrange one before sharing details.

In the private report, include the affected version and runtime, impact,
reproduction steps using synthetic data, and any proposed mitigation. Coordinate
public disclosure with the maintainers. No response-time or enterprise support
SLA is promised.

## Security boundaries

- Tokens are bearer credentials. Anyone holding a valid token can unsubscribe its
  recipient from its list. Repeated use is allowed, and the callback must be
  idempotent. The `oneClick` context field describes the submitted form; it does
  not identify a mail provider, browser, or person.
- Tokens are signed, not encrypted. Their payload exposes the recipient address
  and list identifier. Redact tokens and unsubscribe URLs from access logs,
  traces, analytics, error reports, and third-party content.
- Generate signing secrets with a cryptographically secure random source and
  store them in a secret manager. A string-length check does not establish key
  entropy. Use separate secrets for unrelated applications.
- Keep an old secret in `previousSecrets` only while its tokens should remain
  valid. Removing a compromised key invalidates tokens signed with that key;
  stateless tokens do not support individual revocation.
- The application owns durable suppression storage, tenant/list authorization at
  token issuance, and preventing future sends. Only resolve the callback after
  the suppression has been durably recorded, and propagate storage failures.
- Run the endpoint behind HTTPS with request size, timeout, and concurrency
  limits. Apply limits to Express body parsers as well as the hosting platform.
  Preserve legitimate mail receiver access without login, CAPTCHA, or redirect
  requirements. Keep unsubscribe pages free of third-party resources.
- Escape values interpolated by custom HTML confirmation renderers. Defaults do
  not make arbitrary application-provided HTML safe.

The library does not operate a mail service or suppression database, manage DKIM,
or certify regulatory compliance. Deployment guidance is in the README and
[OPERATIONS.md](OPERATIONS.md).
