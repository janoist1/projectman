import { parseDocument } from 'yaml';
import type { FastifyBaseLogger } from 'fastify';
import {
  effectiveRepo,
  filesByModule,
  LOCAL_ENGINE_ID,
  operatorOf,
  StructureMap,
  STRUCTURE_MAP_PATH,
  STRUCTURE_RECENT_DONE_DAYS,
} from '@projectman/shared';
import type {
  EngineId,
  ProjectConfig,
  RepoConfig,
  StructureCard,
  StructureCardSource,
  StructureRepoView,
  StructureView,
  Task,
} from '@projectman/shared';
import { MAX_CHANGED_ITEMS, MergeError } from '../../contracts';
import type { BranchMerger, ChangedPathsItem, ChangedPathsResult, EngineDirectory } from '../../contracts';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';

export interface StructureService {
  view(projectKey: string): Promise<StructureView>;
}
export interface StructureSessions {
  cardEngineId(projectKey: string, task: Task): EngineId;
}
export interface StructureDeps {
  projects: Pick<ProjectService, 'config'>;
  tasks: Pick<TaskService, 'list'>;
  engines: EngineDirectory;
  sessions: StructureSessions;
  logger: Pick<FastifyBaseLogger, 'warn'>;
  now?: () => number;
}
type Selection = { task: Task; source: StructureCardSource; item: ChangedPathsItem };
type Paths = Extract<ChangedPathsResult, { ok: true }>;

function errorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'linkCode' in error &&
    typeof error.linkCode === 'string'
  )
    return error.linkCode;
  return error instanceof MergeError ? error.code : 'internal';
}

function select(config: ProjectConfig, tasks: Task[], repo: string, now: number): Selection[] {
  const result: Selection[] = [];
  for (const task of tasks) {
    if (effectiveRepo(config, task) !== repo) continue;
    let source: StructureCardSource;
    let at: ChangedPathsItem['at'];
    if (task.status === 'active' && task.reviewPin) {
      source = 'review';
      at = { commit: task.reviewPin.commit };
    } else if (task.status === 'active') {
      const branch = task.links.filter((link) => link.kind === 'branch').at(-1);
      if (!branch) continue;
      source = 'branch';
      at = { branch: branch.ref };
    } else if (
      task.status === 'done' &&
      task.merged?.mergeCommit &&
      Date.parse(task.merged.at) >= now - STRUCTURE_RECENT_DONE_DAYS * 86_400_000 &&
      Date.parse(task.merged.at) <= now
    ) {
      source = 'merge';
      at = { merge: task.merged.mergeCommit };
    } else continue;
    result.push({ task, source, item: { id: task.key, at } });
  }
  const priority = { review: 0, branch: 1, merge: 2 };
  return result
    .sort(
      (a, b) => priority[a.source] - priority[b.source] || b.task.updatedAt.localeCompare(a.task.updatedAt),
    )
    .slice(0, 300);
}

export function createStructureService(deps: StructureDeps): StructureService {
  const now = deps.now ?? Date.now;
  const views = new Map<string, { expires: number; value: StructureView }>();
  const running = new Map<string, Promise<StructureView>>();
  const merges = new Map<string, Paths>();
  const mergeKey = (project: string, repo: string, commit: string) => JSON.stringify([project, repo, commit]);
  async function cards(
    projectKey: string,
    repo: RepoConfig,
    map: StructureMap,
    selections: Selection[],
    baseEngine: EngineId | null,
  ): Promise<StructureCard[]> {
    const results = new Map<string, Paths>();
    const groups = new Map<EngineId, Selection[]>();
    for (const selection of selections) {
      const commit = 'merge' in selection.item.at ? selection.item.at.merge : null;
      const cached = commit ? merges.get(mergeKey(projectKey, repo.name, commit)) : undefined;
      if (cached) {
        results.set(selection.task.key, cached);
        continue;
      }
      const engine =
        selection.source === 'merge' ? baseEngine : deps.sessions.cardEngineId(projectKey, selection.task);
      if (!engine) {
        deps.logger.warn(
          { projectKey, repo: repo.name, engine, code: 'link_down', tasks: [selection.task.key] },
          'Structure card read failed',
        );
        continue;
      }
      const group = groups.get(engine) ?? [];
      group.push(selection);
      groups.set(engine, group);
    }
    for (const [engine, group] of groups) {
      const merger = deps.engines.get(engine)?.merger;
      if (!merger) {
        deps.logger.warn(
          { projectKey, repo: repo.name, engine, code: 'link_down', tasks: group.map((s) => s.task.key) },
          'Structure card read failed',
        );
        continue;
      }
      for (let offset = 0; offset < group.length; offset += MAX_CHANGED_ITEMS) {
        const batch = group.slice(offset, offset + MAX_CHANGED_ITEMS);
        try {
          const changed = await merger.changedPaths(
            { projectKey, repo: repo.name },
            { base: repo.defaultBranch, items: batch.map((s) => s.item) },
          );
          for (const result of changed) {
            const selection = batch.find((s) => s.task.key === result.id);
            if (!selection) continue;
            if (!result.ok) {
              deps.logger.warn(
                { projectKey, repo: repo.name, engine, code: result.reason, tasks: [result.id] },
                'Structure card read failed',
              );
              continue;
            }
            results.set(result.id, result);
            if ('merge' in selection.item.at) {
              const key = mergeKey(projectKey, repo.name, selection.item.at.merge);
              if (!merges.has(key)) merges.set(key, result);
              if (merges.size > 5000) merges.delete(merges.keys().next().value!);
            }
          }
        } catch (error) {
          deps.logger.warn(
            {
              projectKey,
              repo: repo.name,
              engine,
              code: errorCode(error),
              tasks: batch.map((s) => s.task.key),
            },
            'Structure card read failed',
          );
        }
      }
    }
    return selections.flatMap((selection) => {
      const result = results.get(selection.task.key);
      if (!result) return [];
      const placed = filesByModule(map, result.paths);
      return [
        {
          taskKey: selection.task.key,
          source: selection.source,
          commit: result.commit,
          files: result.paths.length,
          modules: placed.modules,
          unmapped: placed.unmapped.slice(0, 10),
          truncated: result.truncated,
        },
      ];
    });
  }
  async function repoView(
    projectKey: string,
    config: ProjectConfig,
    repo: RepoConfig,
    tasks: Task[],
  ): Promise<StructureRepoView> {
    const view: StructureRepoView = {
      repo: repo.name,
      status: 'unavailable',
      problem: null,
      reason: 'engine_offline',
      commit: null,
      map: null,
      sizes: [],
      unmapped: { count: 0, examples: [] },
      truncated: false,
      cards: [],
      readAt: new Date(now()).toISOString(),
    };
    const operator = operatorOf(config);
    const engine = operator ? deps.engines.engineFor(projectKey, operator.handle) : LOCAL_ENGINE_ID;
    const merger: BranchMerger | undefined = engine ? deps.engines.get(engine)?.merger : undefined;
    if (!merger) return view;
    let paths: Awaited<ReturnType<BranchMerger['listPaths']>>;
    let text: string | null;
    try {
      paths = await merger.listPaths({ projectKey, repo: repo.name }, { base: repo.defaultBranch });
      text = (
        await merger.readFile(
          { projectKey, repo: repo.name },
          { at: { commit: paths.commit }, path: STRUCTURE_MAP_PATH },
        )
      ).text;
    } catch (error) {
      const code = errorCode(error);
      deps.logger.warn(
        { projectKey, repo: repo.name, engine, code, tasks: [] },
        'Structure repository read failed',
      );
      const reason =
        code === 'merge_not_allowed' || code === 'repo_not_registered'
          ? 'not_allowed'
          : code === 'link_down' || code === 'timeout'
            ? 'engine_offline'
            : 'failed';
      return { ...view, reason };
    }
    view.commit = paths.commit;
    view.reason = null;
    if (text === null) return { ...view, status: 'missing' };
    let map: StructureMap;
    try {
      const document = parseDocument(text);
      if (document.errors.length)
        return {
          ...view,
          status: 'invalid',
          problem: document.errors
            .map((error) => error.message)
            .join('; ')
            .slice(0, 500),
        };
      const parsed = StructureMap.safeParse(document.toJS());
      if (!parsed.success)
        return {
          ...view,
          status: 'invalid',
          problem: parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')
            .slice(0, 500),
        };
      map = parsed.data;
    } catch (error) {
      return { ...view, status: 'invalid', problem: String(error).slice(0, 500) };
    }
    const placed = filesByModule(map, paths.paths);
    return {
      ...view,
      status: 'ok',
      map,
      sizes: placed.modules,
      unmapped: { count: placed.unmapped.length, examples: placed.unmapped.slice(0, 10) },
      truncated: paths.truncated,
      cards: await cards(projectKey, repo, map, select(config, tasks, repo.name, now()), engine),
    };
  }
  return {
    view(projectKey) {
      const cached = views.get(projectKey);
      if (cached && cached.expires > now()) return Promise.resolve(cached.value);
      const pending = running.get(projectKey);
      if (pending) return pending;
      const promise = (async () => {
        const config = await deps.projects.config(projectKey);
        const tasks = deps.tasks.list(projectKey);
        const repos: StructureRepoView[] = [];
        for (const repo of config.project.repos) repos.push(await repoView(projectKey, config, repo, tasks));
        const value = { repos };
        views.set(projectKey, { expires: now() + 30_000, value });
        return value;
      })().finally(() => running.delete(projectKey));
      running.set(projectKey, promise);
      return promise;
    },
  };
}
