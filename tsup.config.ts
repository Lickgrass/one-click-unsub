import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', express: 'src/express.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
  // Keep `node:crypto` as written — Workers (nodejs_compat) and Deno resolve
  // the prefixed form; tsup would strip it by default.
  removeNodeProtocol: false,
});
