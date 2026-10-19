export type MergeTestWorkspace =
  'packages/shared' | 'packages/templates' | 'apps/feedback-widget' | 'apps/server' | 'apps/web';
export type MergeTestScope =
  | { kind: 'all'; reason: string }
  | { kind: 'workspaces'; workspaces: MergeTestWorkspace[]; fallback?: string; sharedChanged?: string[] }
  | {
      kind: 'shared';
      exports: string[];
      workspaces: MergeTestWorkspace[];
      tests?: string[];
      fallback?: string;
    }
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
  const sharedChanged: string[] = [];
  for (const file of files) {
    if (
      (file.startsWith('packages/') && !file.startsWith('packages/shared/')) ||
      file.startsWith('scripts/') ||
      file.startsWith('apps/server/test/architecture/') ||
      file.startsWith('apps/server/src/contracts/') ||
      file.startsWith('apps/server/src/config/') ||
      isFullRunConfig(file)
    )
      return { kind: 'all', reason: file };
    if (file.startsWith('packages/shared/')) {
      workspaces.add('packages/shared');
      if (file.startsWith('packages/shared/src/')) sharedChanged.push(file);
    } else if (file.startsWith('apps/feedback-widget/')) workspaces.add('apps/feedback-widget');
    else if (file.startsWith('apps/server/')) workspaces.add('apps/server');
    else if (file.startsWith('apps/web/')) workspaces.add('apps/web');
    else return { kind: 'all', reason: file };
  }
  return workspaces.size
    ? {
        kind: 'workspaces',
        workspaces: [...workspaces].sort(),
        ...(workspaces.has('packages/shared') ? { sharedChanged: [...new Set(sharedChanged)].sort() } : {}),
      }
    : { kind: 'none' };
}
