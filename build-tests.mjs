// Bundles the TypeScript tests so `node --test` can run them without a loader.
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { glob } from 'node:fs/promises';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, 'dist-test');
await rm(outdir, { recursive: true, force: true });

const entryPoints = [];
for await (const entry of glob('test/*.test.ts', { cwd: root })) {
  entryPoints.push(path.join(root, entry));
}

await build({
  entryPoints,
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'warning',
});
