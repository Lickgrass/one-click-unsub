import assert from 'node:assert/strict';
import { cpus, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createTokenCodec, createUnsubscribe } from '../dist/index.js';

// Run after building: node scripts/benchmark.mjs
// This is an in-process microbenchmark, not a network or database load test.
const rawIterations = process.env.BENCH_ITERATIONS ?? '20000';
if (!/^[1-9]\d*$/.test(rawIterations)) {
  throw new Error('BENCH_ITERATIONS must be an integer from 1000 to 100000');
}
const baseIterations = Number(rawIterations);
if (!Number.isSafeInteger(baseIterations) || baseIterations < 1000 || baseIterations > 100000) {
  throw new Error('BENCH_ITERATIONS must be an integer from 1000 to 100000');
}

const sampleCount = 5;
const clock = Date.UTC(2026, 0, 1);
const now = () => clock;
const secret = 'benchmark-only-current-secret-do-not-use-in-production';
const previousSecrets = Array.from({ length: 64 }, (_, i) =>
  `benchmark-only-previous-secret-${String(i).padStart(2, '0')}-do-not-use`,
);
const identities = Array.from({ length: 128 }, (_, i) => ({
  list: 'benchmark-newsletter',
  email: `recipient-${i}@example.invalid`,
}));
const identityAt = (i) => identities[i % identities.length];
const codec = createTokenCodec({ secret, now });
const tokens = identities.map((identity) => codec.mint(identity));
const forgedTokens = tokens.map((token) => {
  // Change a full base64url character in the signature, preserving its shape.
  const start = token.indexOf('.') + 1;
  return `${token.slice(0, start)}${token[start] === 'A' ? 'B' : 'A'}${token.slice(start + 1)}`;
});
const oversizedToken = 'a'.repeat(8193);
const tokenAt = (collection, i) => collection[i % collection.length];

const fewKeys = createTokenCodec({ secret, previousSecrets: previousSecrets.slice(0, 2), now });
const manyKeys = createTokenCodec({ secret, previousSecrets, now });
const fewOldSigner = createTokenCodec({ secret: previousSecrets[1], now });
const manyOldSigner = createTokenCodec({ secret: previousSecrets[63], now });
const fewOldTokens = identities.map((identity) => fewOldSigner.mint(identity));
const manyOldTokens = identities.map((identity) => manyOldSigner.mint(identity));

const unsub = createUnsubscribe({
  secret,
  now,
  baseUrl: 'https://mail.example.invalid',
  address: 'Example Inc, 123 Example Street, Example City',
  from: 'sender@example.invalid',
});
const requestUrls = tokens.map((token) => unsub.urls(token).oneClick);
const formBody = 'List-Unsubscribe=One-Click';
let callbackCount = 0;
let oneClickCount = 0;
let unexpectedPayloadCount = 0;
const handler = unsub.handler((payload, context) => {
  // Instrumentation only: no storage, timers, network, or simulated I/O.
  callbackCount++;
  if (context.oneClick) oneClickCount++;
  if (payload.list !== 'benchmark-newsletter' || !payload.email.endsWith('@example.invalid')) {
    unexpectedPayloadCount++;
  }
});

function checkPayload(payload, i) {
  assert.ok(payload, 'valid token was rejected');
  assert.equal(payload.list, identityAt(i).list);
  assert.equal(payload.email, identityAt(i).email);
  assert.ok(payload.expiresAt > clock);
}

const results = [];
function record(name, iterations, warmupIterations, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const medianMs = sorted[Math.floor(sorted.length / 2)];
  results.push({
    workload: name,
    iterations_per_sample: iterations,
    warmup_iterations: warmupIterations,
    median_ops_per_second: Math.round(iterations / (medianMs / 1000)),
    median_sample_us_per_op: Number((medianMs * 1000 / iterations).toFixed(3)),
    sample_ms: samples.map((ms) => Number(ms.toFixed(3))),
  });
}

function measureSync(name, iterations, operation, validate) {
  const warmupIterations = Math.max(50, Math.floor(iterations / 10));
  let result;
  for (let i = 0; i < warmupIterations; i++) result = operation(i);
  validate(result, warmupIterations - 1);
  const samples = [];
  for (let sample = 0; sample < sampleCount; sample++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) result = operation(i);
    samples.push(performance.now() - start);
    // Check returned data outside the timed loop to avoid assertion overhead.
    validate(result, iterations - 1);
  }
  record(name, iterations, warmupIterations, samples);
}

async function measureHandler(iterations) {
  const warmupIterations = Math.max(50, Math.floor(iterations / 10));
  const run = async (count) => {
    let response;
    for (let i = 0; i < count; i++) {
      response = await handler(new Request(tokenAt(requestUrls, i), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody,
      }));
      if (response.status !== 200) throw new Error(`Handler returned ${response.status}`);
    }
    return response;
  };
  const before = callbackCount;
  await run(warmupIterations);
  const samples = [];
  for (let sample = 0; sample < sampleCount; sample++) {
    const start = performance.now();
    const response = await run(iterations);
    samples.push(performance.now() - start);
    assert.equal(await response.text(), '');
  }
  assert.equal(callbackCount - before, warmupIterations + iterations * sampleCount);
  assert.equal(oneClickCount, callbackCount);
  assert.equal(unexpectedPayloadCount, 0);
  record('Fetch POST, form parsing + instrumented no-op callback', iterations, warmupIterations, samples);
}

console.log(JSON.stringify({
  benchmark: 'one-click-unsub in-process ESM microbenchmark',
  date: new Date().toISOString(),
  node: process.version,
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0]?.model ?? 'unknown',
  sample_count: sampleCount,
  base_iterations: baseIterations,
  identities: identities.length,
  token_characters: { min: Math.min(...tokens.map((token) => token.length)), max: Math.max(...tokens.map((token) => token.length)) },
  oversized_token_characters: oversizedToken.length,
  body_bytes: Buffer.byteLength(formBody),
  clock: new Date(clock).toISOString(),
  key_counts: [1, 3, 65],
  methodology: 'One untimed warmup then five sequential samples per workload; median elapsed sample determines throughput and amortized microseconds/op. No explicit GC. Codec and token fixture setup are excluded.',
  limitations: 'No network, database, concurrency, or end-to-end latency measurement. Fetch timing includes Request construction, a status check, form parsing, token verification, Response construction, and callback instrumentation. Oversized rejection may be dominated by loop overhead.',
}, null, 2));

measureSync('mint, 1 key', baseIterations,
  (i) => codec.mint(identityAt(i)),
  (token, i) => checkPayload(codec.verify(token), i));
measureSync('verify valid, 1 key', baseIterations,
  (i) => codec.verify(tokenAt(tokens, i)), checkPayload);
measureSync('verify forged signature, 1 key', baseIterations,
  (i) => codec.verify(tokenAt(forgedTokens, i)), (payload) => assert.equal(payload, null));
measureSync('reject oversized token, 1 key', baseIterations,
  () => codec.verify(oversizedToken), (payload) => assert.equal(payload, null));
measureSync('verify oldest key, 2 previous + current', Math.ceil(baseIterations / 3),
  (i) => fewKeys.verify(tokenAt(fewOldTokens, i)), checkPayload);
measureSync('verify oldest key, 64 previous + current', Math.ceil(baseIterations / 65),
  (i) => manyKeys.verify(tokenAt(manyOldTokens, i)), checkPayload);
measureSync('verify forged signature, 64 previous + current', Math.ceil(baseIterations / 65),
  (i) => manyKeys.verify(tokenAt(forgedTokens, i)), (payload) => assert.equal(payload, null));
measureSync('decorate, headers + mailto + HTML/text footer', Math.ceil(baseIterations / 2),
  (i) => unsub.decorate(identityAt(i)), (decoration, i) => {
    checkPayload(codec.verify(decoration.token), i);
    assert.equal(decoration.headers['List-Unsubscribe-Post'], formBody);
    assert.ok(decoration.headers['List-Unsubscribe'].includes(decoration.unsubscribeUrl));
    assert.ok(decoration.footer.html.includes('Example Inc'));
    assert.ok(decoration.footer.text.includes('Example Inc'));
  });
await measureHandler(Math.max(100, Math.ceil(baseIterations / 20)));

console.table(results.map(({ sample_ms: _samples, ...row }) => row));
console.log(JSON.stringify({ results }, null, 2));
