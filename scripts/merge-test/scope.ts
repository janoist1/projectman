export type MergeTestWorkspace = 'apps/server' | 'apps/web';
export type MergeTestScope =
  | { kind: 'all'; reason: string }
  | { kind: 'workspaces'; workspaces: MergeTestWorkspace[]; fallback?: string }
  | { kind: 'modules'; modules: string[]; tests: string[]; workspaces: MergeTestWorkspace[] }
  | { kind: 'none' };

export function mergeTestScope(changed: readonly string[]): MergeTestScope {
  const workspaces = new Set<MergeTestWorkspace>();
  for (const file of changed) {
    if (file.startsWith('docs/') || /^[^/]+\.md$/.test(file)) continue;
    const name = file.split('/').at(-1)!;
    if (
      file.startsWith('packages/') ||
      file.startsWith('scripts/') ||
      file.startsWith('apps/server/test/architecture/') ||
      file.startsWith('apps/server/src/contracts/') ||
      file.startsWith('apps/server/src/config/') ||
      name === 'package.json' ||
      name === 'package-lock.json' ||
      /^tsconfig.*\.json$/.test(name) ||
      /^vitest\.config\./.test(name)
    )
      return { kind: 'all', reason: file };
    if (file.startsWith('apps/server/')) workspaces.add('apps/server');
    else if (file.startsWith('apps/web/')) workspaces.add('apps/web');
    else return { kind: 'all', reason: file };
  }
  return workspaces.size ? { kind: 'workspaces', workspaces: [...workspaces].sort() } : { kind: 'none' };
}
