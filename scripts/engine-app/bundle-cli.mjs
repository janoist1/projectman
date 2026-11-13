// Bundles the engine CLI (scripts/engine/cli.ts) into scripts/engine/cli.js for an engine package (PM-1121),
// run from the checkout root by `npm run engine-app -- package`. Like apps/server/scripts/build.mjs: the workspace
// packages (TypeScript source) are bundled, the server's third-party dependencies stay external and are resolved
// from the package's node_modules, native modules included.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const serverManifest = JSON.parse(readFileSync('apps/server/package.json', 'utf8'));
const external = Object.keys(serverManifest.dependencies ?? {}).filter(
  (name) => !name.startsWith('@projectman/'),
);

// The engine CLI, and the `projectman` client (PM-1429; its entry has no tsx), bundled the same way.
for (const [entry, outfile] of [
  ['scripts/engine/cli.ts', 'scripts/engine/cli.js'],
  ['scripts/projectman/entry.ts', 'scripts/projectman/cli.js'],
]) {
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
