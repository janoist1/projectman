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
  | { kind: 'owned'; rules: string[]; tests: string[] }
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
 * Paths only a few server tests read, by path and not by import (Swift sources, plists, workflows, the
 * structure map, the merge-test scripts). A change that touches only these (and the tests of the rules)
 * runs the rules' tests instead of the whole suite (PM-1354). `tests` entries are vitest filters: a test
 * file, a file name prefix or a folder. A test that reads one of these paths must be named by a rule
 * (the guard in `merge-test-scope.test.ts`).
 */
export interface OwnedPathRule {
  id: string;
  sources: readonly RegExp[];
  tests: readonly string[];
}

const ARCHITECTURE_TESTS = 'apps/server/test/architecture/';
export const OWNED_PATH_RULES: readonly OwnedPathRule[] = [
  {
    id: 'deploy-mac-workflows',
    sources: [/^deploy\/mac\//, /^\.github\/workflows\/[^/]+\.ya?ml$/],
    tests: [
      'apps/server/test/engine-menubar.test.ts',
      'apps/server/test/engine-app-package.test.ts',
      'apps/server/test/engine-app-build.test.ts',
      'apps/server/test/engine-app-fetch.test.ts',
      'apps/server/test/engine-release-workflow.test.ts',
      'apps/server/test/merge-check-workflow.test.ts',
      'apps/server/test/projectman-job-workflow.test.ts',
      // The structure map test reads every tracked file of the repository.
      ARCHITECTURE_TESTS,
    ],
  },
  {
    id: 'structure-map',
    sources: [/^projectman\.structure\.yaml$/, /^apps\/server\/test\/architecture\//],
    tests: [
      ARCHITECTURE_TESTS,
      'apps/server/test/structure-api.test.ts',
      'apps/server/src/services/structure/structure.test.ts',
      // The module map reads the structure map, and the impact analysis tests import the module map.
      'apps/server/test/merge-test-',
    ],
  },
  {
    id: 'merge-test-scripts',
    sources: [/^scripts\/merge-test\//],
    tests: ['apps/server/test/merge-test-', ARCHITECTURE_TESTS],
  },
];

/** The owned scope of a change, when every file belongs to a rule or is a test of one. */
function ownedScope(files: readonly string[]): MergeTestScope | undefined {
  const isSource = (rule: OwnedPathRule, file: string): boolean => rule.sources.some((re) => re.test(file));
  const isRuleTest = (file: string): boolean =>
    OWNED_PATH_RULES.some((rule) => rule.tests.some((entry) => file.startsWith(entry)));
  const hit = OWNED_PATH_RULES.filter((rule) => files.some((file) => isSource(rule, file)));
  if (
    !hit.length ||
    !files.every(
      (file) =>
        !isFullRunConfig(file) &&
        (isRuleTest(file) ||
          Object.hasOwn(TEST_READ_DOCS, file) ||
          OWNED_PATH_RULES.some((rule) => isSource(rule, file))),
    )
  )
    return undefined;
  // A changed test of another rule runs too: its own path is not a source of the rules that were hit.
  const changedTests = files.filter(
    (file) =>
      isRuleTest(file) && !hit.some((rule) => isSource(rule, file)) && /\.test\.[cm]?[jt]sx?$/.test(file),
  );
  return {
    kind: 'owned',
    rules: hit.map((rule) => rule.id),
    tests: [...new Set([...hit.flatMap((rule) => rule.tests), ...changedTests, ...testsReadingDocs(files)])],
  };
}

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
  const owned = ownedScope(files);
  if (owned) return owned;

  const workspaces = new Set<MergeTestWorkspace>();
  const sharedChanged: string[] = [];
  for (const file of files) {
    if (
      (file.startsWith('packages/') &&
        !file.startsWith('packages/shared/') &&
        !file.startsWith('packages/templates/')) ||
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
    } else if (file.startsWith('packages/templates/')) workspaces.add('packages/templates');
    else if (
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
