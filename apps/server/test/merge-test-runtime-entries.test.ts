import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isRuntimeImport } from '../../../scripts/merge-test/impact';
import { RUNTIME_ENTRIES } from '../../../scripts/merge-test/runtime-entries';
import { sourceImports } from './architecture/check';

function checkEntries(
  entries: Readonly<Record<string, readonly string[]>>,
  read: (path: string) => string | undefined,
): void {
  for (const [path, targets] of Object.entries(entries)) {
    const source = read(path);
    expect(source, `Missing file: ${path}; remove from RUNTIME_ENTRIES`).toBeDefined();
    expect(
      sourceImports(source!).specifiers.some(isRuntimeImport),
      `No runtime import in ${path}; remove from RUNTIME_ENTRIES`,
    ).toBe(true);
    for (const target of targets)
      expect(read(target), `Missing runtime entry: ${path} -> ${target}`).toBeDefined();
  }
}

describe('merge test runtime entries', () => {
  it('keeps only existing runtime importers and repository entrypoints', () => {
    const root = new URL('../../../', import.meta.url);
    checkEntries(RUNTIME_ENTRIES, (path) => {
      const file = fileURLToPath(new URL(path, root));
      return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    });
  });
  it.each([undefined, "import 'node:fs';"])(
    'rejects a stale key after deletion or removal of its runtime import',
    (source) => {
      expect(() => checkEntries({ 'old.ts': [] }, () => source)).toThrow('remove from RUNTIME_ENTRIES');
    },
  );
  it('rejects an entrypoint that was removed', () => {
    expect(() =>
      checkEntries({ 'launcher.ts': ['gone.ts'] }, (path) =>
        path === 'launcher.ts' ? "import 'child_process';" : undefined,
      ),
    ).toThrow('Missing runtime entry');
  });
});
