import { MODULES } from '../../apps/server/test/architecture/module-map';
import { serverTestImpact } from './impact';
import type { MergeTestFile } from './impact';
import type { MergeTestScope } from './scope';
import { sharedImpact } from './shared-impact';
import { MERGE_TEST_WORKSPACES } from './steps';

const underServer = (file: MergeTestFile): boolean =>
  file.path.startsWith('apps/server/') || file.path.startsWith('scripts/');

/** Whether refining the scope needs the file contents of both revisions, and which roots it reads. */
export function refineRoots(scope: MergeTestScope): string[] | undefined {
  if (scope.kind !== 'workspaces') return undefined;
  if (scope.sharedChanged !== undefined) return [...MERGE_TEST_WORKSPACES, 'scripts'];
  return scope.workspaces.includes('apps/server') ? ['apps/server', 'scripts'] : undefined;
}

function sharedScope(
  scope: Extract<MergeTestScope, { kind: 'workspaces' }>,
  changed: readonly string[],
  before: readonly MergeTestFile[],
  after: readonly MergeTestFile[],
): MergeTestScope {
  // Non-source shared changes need no consumer analysis, but still check every workspace's types.
  const shared = scope.sharedChanged?.length
    ? sharedImpact({ changed: scope.sharedChanged, before, after })
    : {
        exports: [],
        consumers: {
          'apps/server': [],
          'apps/web': [],
          'apps/feedback-widget': [],
          'packages/templates': [],
        },
      };
  if ('fallback' in shared) return { kind: 'all', reason: shared.fallback };
  if (shared.consumers['packages/templates'].length)
    return { kind: 'all', reason: 'shared consumer in packages/templates' };
  const workspaces = MERGE_TEST_WORKSPACES.filter(
    (ws) => scope.workspaces.includes(ws) || (ws !== 'packages/shared' && shared.consumers[ws].length > 0),
  );
  const server = workspaces.includes('apps/server')
    ? serverTestImpact({
        changed,
        seeds: shared.consumers['apps/server'],
        before: before.filter(underServer),
        after: after.filter(underServer),
        modules: MODULES,
      })
    : undefined;
  return {
    kind: 'shared',
    exports: shared.exports,
    workspaces,
    ...(server?.fallback ? { fallback: server.fallback } : server ? { tests: server.tests } : {}),
  };
}

/**
 * The merge check's scope for a change, from the coarse path scope: the shared export analysis and the
 * server module analysis narrow it where they can prove it. `before` and `after` hold the files of
 * `refineRoots(scope)` at the two revisions.
 */
export function refineScope(
  scope: MergeTestScope,
  changed: readonly string[],
  before: readonly MergeTestFile[],
  after: readonly MergeTestFile[],
): MergeTestScope {
  if (refineRoots(scope) === undefined || scope.kind !== 'workspaces') return scope;
  if (scope.sharedChanged !== undefined) return sharedScope(scope, changed, before, after);
  const impact = serverTestImpact({
    changed,
    before: before.filter(underServer),
    after: after.filter(underServer),
    modules: MODULES,
  });
  return impact.fallback
    ? { ...scope, fallback: impact.fallback }
    : {
        kind: 'modules',
        modules: impact.modules,
        tests: impact.tests,
        workspaces: scope.workspaces.filter((ws) => ws !== 'apps/server'),
      };
}
