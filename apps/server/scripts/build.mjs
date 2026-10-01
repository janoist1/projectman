// Bundles the server (including the workspace packages, which ship TypeScript source)
// into dist/index.js. Third-party dependencies stay external, native modules included.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@projectman/'));

// The server, and the programs of the managed VM boundary (PM-140): the root launcher, the
// claude-trust helper and the boundary probe it runs as a worker, and verify.sh's measurement that
// drives that probe. Each is its own bundle.
const entries = {
  'dist/index.js': 'src/index.ts',
  'dist/launcher.js': 'src/runtime-boundary/launcher/main.ts',
  'dist/claude-trust.js': 'src/runtime-boundary/claude-trust.ts',
  'dist/boundary-probe.js': 'src/runtime-boundary/probe/boundary-probe.ts',
  'dist/boundary-worker-probe.js': 'src/runtime-boundary/probe/worker-probe.ts',
};
for (const [outfile, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    external,
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
  console.log(`built ${outfile}`);
}
