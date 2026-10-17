export type MergeTestWorkspace = 'apps/server' | 'apps/web';
export type MergeTestScope =
  | { kind: 'all'; reason: string }
  | { kind: 'workspaces'; workspaces: MergeTestWorkspace[]; fallback?: string }
  | { kind: 'modules'; modules: string[]; tests: string[]; workspaces: MergeTestWorkspace[] }
  | { kind: 'cloud' }
  | { kind: 'none' };

function isFullRunConfig(file: string): boolean {
  const name = file.split('/').at(-1)!;
  return (
    name === 'package.json' ||
    name === 'package-lock.json' ||
    /^tsconfig.*\.json$/.test(name) ||
    /^vitest\.config\./.test(name)
  );
}

export function mergeTestScope(changed: readonly string[]): MergeTestScope {
  const files = changed.filter((file) => !file.startsWith('docs/') && !/^[^/]+\.md$/.test(file));
  const isCloudInfra = (file: string): boolean =>
    ['scripts/cloud/', 'deploy/aws/', 'deploy/cloud/'].some((prefix) => file.startsWith(prefix));
  if (
    files.some(isCloudInfra) &&
    files.every(
      (file) =>
        !isFullRunConfig(file) &&
        (isCloudInfra(file) || /^apps\/server\/test\/(cloud|deploy|release)-[^/]+\.test\.ts$/.test(file)),
    )
  )
    return { kind: 'cloud' };

  const workspaces = new Set<MergeTestWorkspace>();
  for (const file of files) {
    if (
      file.startsWith('packages/') ||
      file.startsWith('scripts/') ||
      file.startsWith('apps/server/test/architecture/') ||
      file.startsWith('apps/server/src/contracts/') ||
      file.startsWith('apps/server/src/config/') ||
      isFullRunConfig(file)
    )
      return { kind: 'all', reason: file };
    if (file.startsWith('apps/server/')) workspaces.add('apps/server');
    else if (file.startsWith('apps/web/')) workspaces.add('apps/web');
    else return { kind: 'all', reason: file };
  }
  return workspaces.size ? { kind: 'workspaces', workspaces: [...workspaces].sort() } : { kind: 'none' };
}
