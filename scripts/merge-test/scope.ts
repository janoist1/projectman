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

/** The vitest filters of the cloud scope: the deploy and release tests plus the checks that guard them. */
export const CLOUD_TEST_FILTERS = [
  'apps/server/test/cloud-',
  'apps/server/test/deploy-',
  'apps/server/test/release-',
  'apps/server/test/architecture/',
  'apps/server/test/merge-test-',
  // They read the Dockerfile and the history fixture generator of deploy/cloud by path (PM-1337).
  'apps/server/test/memory-profile.test.ts',
  'apps/server/test/history-semantic-profile.test.ts',
  // The real Unix control socket boundary (PM-754): never skipped in a merge.
  'apps/server/test/control-socket.integration.test.ts',
];

/**
 * The documents a server test reads by path, and the tests that read each: a change to one is not a
 * document-only change (PM-1337). A test that reads another document by path adds it here.
 */
export const TEST_READ_DOCS: Readonly<Record<string, readonly string[]>> = {
  'docs/HYBRID.md': [
    'apps/server/test/deploy-cloud.test.ts',
    'apps/server/test/deploy-aws.test.ts',
    'apps/server/test/memory-profile.test.ts',
  ],
  'docs/MACHINE-DEPENDENT.md': ['apps/server/test/memory-profile.test.ts'],
  'docs/ARCHITECTURE.md': ['apps/server/test/history-semantic-recall.test.ts'],
  'docs/EFFECT.md': ['apps/server/test/architecture/effect-allowlist.test.ts'],
};

/** The tests that read a changed document by path, sorted. */
export const testsReadingDocs = (changed: readonly string[]): string[] =>
  [...new Set(changed.flatMap((file) => TEST_READ_DOCS[file] ?? []))].sort();

/** A change no check reads: documents and the dead-code tool's ignore files. */
export function isDocumentFile(file: string): boolean {
  if (Object.hasOwn(TEST_READ_DOCS, file)) return false;
  return file.startsWith('docs/') || /^[^/]+\.md$/.test(file) || ['.gitignore', 'knip.json'].includes(file);
}

export function mergeTestScope(changed: readonly string[]): MergeTestScope {
  const files = changed.filter((file) => !isDocumentFile(file));
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
      file.startsWith('scripts/merge-test/') ||
      file.startsWith('scripts/full-test/') ||
      (file.startsWith('scripts/') && !/\.[cm]?[jt]sx?$/.test(file)) ||
      file.startsWith('apps/server/test/architecture/') ||
      isFullRunConfig(file)
    )
      return { kind: 'all', reason: file };
    if (file.startsWith('packages/shared/')) {
      workspaces.add('packages/shared');
      if (file.startsWith('packages/shared/src/')) sharedChanged.push(file);
    } else if (
      file.startsWith('apps/server/') ||
      file.startsWith('scripts/') ||
      Object.hasOwn(TEST_READ_DOCS, file)
    )
      workspaces.add('apps/server');
    else if (file.startsWith('apps/web/')) workspaces.add('apps/web');
    else if (file.startsWith('apps/feedback-widget/')) workspaces.add('apps/feedback-widget');
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
