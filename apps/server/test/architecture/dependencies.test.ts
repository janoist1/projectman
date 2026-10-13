import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { checkDependencies } from './check';
import type { SourceFile } from './check';
import { EXCEPTIONS, LAYER_RULES, MODULES } from './module-map';

const root = fileURLToPath(new URL('../../src/', import.meta.url));
function sources(folder: string): SourceFile[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.name === '__snapshots__') return [];
    if (entry.isDirectory()) return sources(path);
    if (!entry.isFile() || !entry.name.endsWith('.ts') || /\.(?:test|d)\.ts$/.test(entry.name)) return [];
    return [{ path: relative(root, path).replaceAll('\\', '/'), source: readFileSync(path, 'utf8') }];
  });
}

test('server imports respect the module map and shrinking exception list', () => {
  const violations = checkDependencies(sources(root), MODULES, LAYER_RULES, EXCEPTIONS);
  const report = violations
    .map(({ kind, from, to, detail }) => `${kind}: ${from ?? ''} → ${to ?? ''}: ${detail}`)
    .join('\n');
  expect(violations, report).toEqual([]);
});
