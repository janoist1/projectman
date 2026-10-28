// Bundles the server (including the workspace packages, which ship TypeScript source)
// into dist/index.js. Third-party dependencies stay external, native modules included.
import { build } from 'esbuild';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@projectman/'));

const entries = {
  'dist/index.js': 'src/index.ts',
  // The embedding worker of the history search (PM-767): a Worker thread entry beside the server bundle.
  'dist/history-semantic-worker.js': 'src/history-semantic/worker.ts',
  // The relay of the cloud's admin channel (PM-749): the container image carries all of apps/server/dist.
  'dist/control/cli.js': 'src/control/cli.ts',
  // The release measurement's server (PM-910): the same server plus a loopback search listener; dist/index.js never loads it.
  'dist/history-semantic-profile.js': 'src/history-semantic-profile.ts',
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

// The embedding model of the history search (PM-767) is a release asset, fetched by
// `npm run prepare:history-model`; a build without it ships a server that searches by text only.
const modelSource = new URL('../models/history', import.meta.url);
rmSync('dist/models/history', { recursive: true, force: true });
if (existsSync(new URL('manifest.json', `${modelSource.href}/`))) {
  cpSync(modelSource, 'dist/models/history', { recursive: true });
  console.log('copied the history model to dist/models/history');
} else {
  console.log('no history model prepared: the build searches the history by text only');
}
