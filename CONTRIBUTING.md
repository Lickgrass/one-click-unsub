# Contributing

Bug reports and focused pull requests are welcome. For suspected vulnerabilities,
follow [SECURITY.md](SECURITY.md) before opening an issue.

## Development

Use the latest Node.js 24 LTS patch and npm. CI checks the minimum supported Node
version and the latest Node.js 22, 24, and 26 releases on Linux, plus Node 24 on
Windows and macOS. Consult `package.json` for
the exact engine range.

```sh
npm ci --ignore-scripts
npm run check
```

`check` runs type checking, tests, the build, and checks of the packaged public
entry points. Use `npm test -- --watch` for local test development.

The package has no runtime dependencies. Keep additions small and explain why a
new dependency or public API is needed. Commit lockfile changes with dependency
updates. Generated `dist/`, `node_modules/`, and package archives are not committed.

## Proposing a change

- Explain the concrete problem and expected behavior, with a small reproduction
  when possible. Use synthetic email addresses, keys, and tokens.
- Add a regression test for a behavior or security fix. Check both Fetch and
  Express adapters when changing behavior shared by them.
- Keep ESM, CommonJS, and TypeScript consumers working. Treat token compatibility,
  existing unsubscribe links, and header formatting as public API contracts.
- Update the README and changelog when public behavior changes. Explain any
  migration needed for existing installations.
- For performance changes, include the command, runtime, workload, and results;
  avoid machine-specific pass/fail thresholds in unit tests.

Run `npm run check` and `npm audit --package-lock-only --audit-level=low` before
submitting. Describe any checks you could not run. Reviews should address the
code and its effects respectfully.

Contributions are licensed under the project's [MIT license](LICENSE).
