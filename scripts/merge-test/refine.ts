import { MODULES } from '../../apps/server/test/architecture/module-map';
import { sourceImports } from '../../apps/server/test/architecture/check';
import { isCode, serverTestImpact } from './impact';
import type { MergeTestFile } from './impact';
import type { MergeTestScope, MergeTestWorkspace } from './scope';
import { sharedImpact } from './shared-impact';
import { MERGE_TEST_WORKSPACES, workspaceOf } from './steps';

const underServer = (file: MergeTestFile): boolean =>
  file.path.startsWith('apps/server/') || file.path.startsWith('scripts/');

/** The workspace whose checks cover a path: the scripts belong to the server's. */
export const checkedBy = (path: string): MergeTestWorkspace | undefined =>
  path.startsWith('scripts/') ? 'apps/server' : workspaceOf(path);

/** The files that import `pkg` (or a subpath of it), and those that do it other than by type. */
export function importersOf(
  files: readonly MergeTestFile[],
  pkg: string,
): { all: string[]; value: string[] } {
  const all: string[] = [];
  const value: string[] = [];
  for (const file of files) {
    if (!isCode(file.path) || !checkedBy(file.path)) continue;
    const imports = sourceImports(file.source);
    const own = (s: string) => s === pkg || s.startsWith(`${pkg}/`);
    if (!imports.specifiers.some(own)) continue;
    all.push(file.path);
    if (imports.specifiers.some((s) => own(s) && !imports.typeOnly.includes(s))) value.push(file.path);
  }
  return { all, value };
}

/** Whether the scope runs the templates workspace because its own files changed. */
const templatesChanged = (scope: Extract<MergeTestScope, { kind: 'workspaces' }>): boolean =>
  scope.workspaces.includes('packages/templates');

/** Refines a change in `packages/templates`: the workspaces and server tests that import it. */
function templatesScope(
  scope: Extract<MergeTestScope, { kind: 'workspaces' }>,
  changed: readonly string[],
  before: readonly MergeTestFile[],
  after: readonly MergeTestFile[],
): MergeTestScope {
  const importers = importersOf(after, '@projectman/templates').all;
  const workspaces = new Set<MergeTestWorkspace>(scope.workspaces);
  for (const path of importers) workspaces.add(checkedBy(path)!);
  const sorted = (list: Iterable<MergeTestWorkspace>) => [...list].sort();
  if (!workspaces.has('apps/server')) return { kind: 'workspaces', workspaces: sorted(workspaces) };
  const impact = serverTestImpact({
    changed,
    seeds: importers.filter((path) => checkedBy(path) === 'apps/server'),
    before: before.filter(underServer),
    after: after.filter(underServer),
    modules: MODULES,
  });
  return impact.fallback
    ? { kind: 'workspaces', workspaces: sorted(workspaces), fallback: impact.fallback }
    : {
        kind: 'modules',
        modules: impact.modules,
        tests: impact.tests,
        workspaces: sorted([...workspaces].filter((ws) => ws !== 'apps/server')),
      };
}

/** Whether refining the scope needs the file contents of both revisions, and which roots it reads. */
export function refineRoots(scope: MergeTestScope): string[] | undefined {
  if (scope.kind !== 'workspaces') return undefined;
  if (scope.sharedChanged !== undefined || templatesChanged(scope))
    return [...MERGE_TEST_WORKSPACES, 'scripts'];
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
  if (templatesChanged(scope)) {
    // The two package analyses do not combine: a shared change next to a templates one runs everything.
    return scope.sharedChanged === undefined
      ? templatesScope(scope, changed, before, after)
      : { kind: 'all', reason: 'packages/templates with packages/shared' };
  }
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
