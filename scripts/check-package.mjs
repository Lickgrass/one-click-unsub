// Exercise the real tarball in a clean consumer, outside the repository's exports.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'one-click-unsub-package-'));
const env = { ...process.env, npm_config_cache: join(temporary, 'npm-cache'), npm_config_update_notifier: 'false' };
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check with npm run check:package');
const run = (command, args, cwd = temporary) => execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  // A publish rehearsal inherits npm's dry-run setting. These two local-only
  // operations still need to create the temporary tarball and consumer files.
  const [pack] = JSON.parse(run(process.execPath, [npmCli, 'pack', '--dry-run=false', '--ignore-scripts', '--json', '--pack-destination', temporary], root));
  assert.ok(pack);
  const files = pack.files.map(({ path }) => path);
  for (const file of files) {
    assert.match(file, /^(dist\/.+\.(?:js|cjs|ts|cts|map)|package\.json|README\.md|LICENSE|SECURITY\.md|OPERATIONS\.md|CHANGELOG\.md|CONTRIBUTING\.md|benchmarks\/node24-2026-09-06\.json)$/);
  }
  for (const file of ['dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.d.cts', 'dist/express.js', 'dist/express.cjs', 'dist/express.d.ts', 'dist/express.d.cts', 'SECURITY.md', 'OPERATIONS.md', 'CONTRIBUTING.md', 'benchmarks/node24-2026-09-06.json']) {
    assert.ok(files.includes(file), `Tarball is missing ${file}`);
  }
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ name: 'package-smoke-consumer', private: true, type: 'module' }));
  run(process.execPath, [npmCli, 'install', '--dry-run=false', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(temporary, pack.filename)]);
  const installed = JSON.parse(readFileSync(join(temporary, 'node_modules/@lickgrass/one-click-unsub/package.json'), 'utf8'));
  assert.equal(Object.keys(installed.dependencies ?? {}).length, 0, 'Must remain free of runtime dependencies');
  assert.equal(Object.keys(installed.optionalDependencies ?? {}).length, 0);
  const smoke = `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '@lickgrass/one-click-unsub';
import { expressOneClick } from '@lickgrass/one-click-unsub/express';
const require = createRequire(import.meta.url);
const cjs = require('@lickgrass/one-click-unsub');
assert.equal(typeof require('@lickgrass/one-click-unsub/express').expressOneClick, 'function');
assert.equal(typeof expressOneClick, 'function');
const options = { secret: 'synthetic-package-test-secret-at-least-32-characters', baseUrl: 'https://mail.example.com', address: '123 Example Street' };
for (const api of [esm, cjs]) {
  const unsub = api.createUnsubscribe(options);
  const d = unsub.decorate({ list: 'news', email: 'test@example.com' });
  assert.equal(unsub.verify(d.token).email, 'test@example.com');
  assert.equal(cjs.createTokenCodec(options).verify(d.token).list, 'news');
  let count = 0;
  const handle = unsub.handler((payload, ctx) => { assert.equal(payload.list, 'news'); assert.equal(ctx.oneClick, true); count++; });
  const response = await handle(new Request(d.unsubscribeUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }));
  assert.equal(response.status, 200);
  assert.equal(count, 1);
  assert.equal(await response.text(), '');
  assert.equal((await handle(new Request(d.unsubscribeUrl))).status, 200);
}
`;
  writeFileSync(join(temporary, 'smoke.mjs'), smoke);
  run(process.execPath, ['smoke.mjs']);
  // Resolve shipped declarations from both .mts and .cts, under NodeNext and
  // legacy node resolution (typesVersions). No repository source imports.
  const fixture = `import { createUnsubscribe, type HandlerOptions, type ListHeaders } from '@lickgrass/one-click-unsub';
import { expressOneClick } from '@lickgrass/one-click-unsub/express';
const unsub = createUnsubscribe({ secret: 'synthetic-type-test-secret-at-least-32-characters', baseUrl: 'https://example.com' });
const callback: HandlerOptions['onUnsubscribe'] = async (payload, ctx) => ({ list: payload.list, oneClick: ctx.oneClick });
const handler: (request: Request) => Promise<Response> = unsub.handler(callback, { bodyTimeoutMs: 1000, onError: (_error: unknown) => {} });
const headers: Record<string, string> = {} as ListHeaders;
expressOneClick(unsub.codec, callback, { onError: (_error: unknown) => {} });
void handler; void headers;
`;
  for (const extension of ['mts', 'cts', 'ts']) writeFileSync(join(temporary, `consumer.${extension}`), fixture);
  const typeRoots = resolve(root, 'node_modules/@types');
  const tsc = resolve(root, 'node_modules/typescript/bin/tsc');
  const shared = ['--noEmit', '--strict', '--exactOptionalPropertyTypes', '--target', 'ES2022', '--types', 'node', '--typeRoots', typeRoots];
  run(process.execPath, [tsc, ...shared, '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.mts', 'consumer.cts']);
  run(process.execPath, [tsc, ...shared, '--module', 'CommonJS', '--moduleResolution', 'Node', 'consumer.ts']);
  console.log(`Package verified: ${pack.filename}; ${files.length} files; ${pack.size} bytes packed; ESM/CJS execution and TypeScript consumers passed.`);
} catch (error) {
  if (error.stdout) console.error(String(error.stdout));
  if (error.stderr) console.error(String(error.stderr));
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
