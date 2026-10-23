import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { newDeadCode } from './dead-code';

const started = Date.now();
try {
  // Use the installed, lockfile-pinned CLI; never download a tool during a merge.
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/knip/bin/knip.js',
      '--config',
      'knip.json',
      '--no-progress',
      '--no-config-hints',
      '--reporter',
      'json',
      '--no-exit-code',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `knip failed (${result.status})`);
  const added = newDeadCode(
    JSON.parse(result.stdout),
    JSON.parse(readFileSync('scripts/merge-test/dead-code-baseline.json', 'utf8')),
  );
  if (added.length) {
    console.error('New unused files or exports (knip):');
    for (const key of added) {
      const [kind, file, name] = JSON.parse(key) as string[];
      console.error(`  ${file}${name ? `: ${name}` : ''} (${kind})`);
    }
    console.error(
      'Remove unused code or exports. For runtime entrypoints, update knip.json; do not regenerate the baseline to hide new issues.',
    );
    process.exitCode = 1;
  } else {
    console.log(`dead-code: no new unused files or exports (${Date.now() - started} ms)`);
  }
} catch (error) {
  console.error(`dead-code: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
