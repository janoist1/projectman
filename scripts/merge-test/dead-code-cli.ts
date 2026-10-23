import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { deadCodeKeys, newDeadCode } from './dead-code';

const started = Date.now();
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--update-baseline'))
    throw new Error('usage: npm run dead-code [-- --update-baseline]');
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
  const report: unknown = JSON.parse(result.stdout);
  const keys = deadCodeKeys(report);
  const baselineFile = 'scripts/merge-test/dead-code-baseline.json';
  if (args[0] === '--update-baseline') {
    writeFileSync(baselineFile, `${JSON.stringify(keys, null, 2)}\n`);
    console.log(`dead-code: wrote ${keys.length} baseline entries; review the diff before committing`);
  } else {
    const baseline: string[] = JSON.parse(readFileSync(baselineFile, 'utf8'));
    const added = newDeadCode(report, baseline);
    const current = new Set(keys);
    const removed = baseline.filter((key) => !current.has(key));
    if (removed.length)
      console.warn(
        `dead-code: ${removed.length} baseline entries no longer reported; the baseline may be pruned`,
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
  }
} catch (error) {
  console.error(`dead-code: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
