import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

/** Static files copied verbatim into dist/. */
const staticFiles = [
  ['src/manifest.json', 'manifest.json'],
  ['src/options/options.html', 'options.html'],
  ['src/blocked/blocked.html', 'blocked.html'],
  ['src/icons', 'icons'],
];

const shared = {
  outdir,
  bundle: true,
  target: 'chrome120',
  platform: 'browser',
  legalComments: 'none',
  logLevel: 'info',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
};

// The service worker is declared as `"type": "module"`; content scripts and
// extension pages are plain classic scripts, which cannot use ESM syntax.
const bundles = [
  { ...shared, format: 'esm', entryPoints: { 'service-worker': 'src/background/service-worker.ts' } },
  {
    ...shared,
    format: 'iife',
    entryPoints: {
      gate: 'src/content/gate.ts',
      'history-hook': 'src/content/history-hook.ts',
      options: 'src/options/options.ts',
      blocked: 'src/blocked/blocked.ts',
    },
  },
].map((cfg) => ({
  ...cfg,
  entryPoints: Object.fromEntries(
    Object.entries(cfg.entryPoints).map(([name, file]) => [name, path.join(root, file)]),
  ),
}));

async function copyStatic() {
  for (const [from, to] of staticFiles) {
    await cp(path.join(root, from), path.join(outdir, to), { recursive: true });
  }
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

if (watch) {
  for (const cfg of bundles) {
    const ctx = await context(cfg);
    await ctx.watch();
  }
  await copyStatic();
  console.log('[cattle-guard] watching; dist/ is loadable as an unpacked extension');
} else {
  await Promise.all(bundles.map((cfg) => build(cfg)));
  await copyStatic();
  console.log('[cattle-guard] built dist/');
}
