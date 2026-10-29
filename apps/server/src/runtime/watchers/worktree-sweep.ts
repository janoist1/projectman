import { ALERT_SEEN_OPTION, alertPayloadOf, isOpenTask, isTheme } from '@projectman/shared';
import type { ProjectConfig, Task, WorktreeKeptAlert } from '@projectman/shared';
import type { EngineDirectory, MemberWorkspaceManager, WorktreeManager } from '../../contracts';
import { ownerHandles } from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import type { DiskGuard } from './disk-guard';
import type { InboxService } from '../../core/inbox';
import type { ProjectService } from '../../core/projects';
import type { SessionOrchestrator } from '../sessions';
import { MergeCardLock } from '../../kernel';

/** A closed card's worktree stays this long: a done card may come back, and the developer may look again. */
const CLOSED_WORKTREE_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

const MB = 1024 ** 2;

/** Snapshot task keys per engine cleanup request. */
const SNAPSHOT_BATCH_SIZE = 100;

interface WorktreeSweepReport {
  removed: string[];
  /** Worktrees with uncommitted changes, left in place. */
  kept: string[];
  /** The growth of the free disk space over the sweep; null when it cannot be measured. */
  freedBytes: number | null;
}

/**
 * Housekeeping of the worktrees of closed cards (PM-243). The cleanup right after a card is done
 * (`SessionOrchestrator.cleanupDoneTask`) keeps a worktree whose commits are not merged yet and is
 * never run again, and every worktree carries its own `node_modules`: they pile up. This sweep goes
 * over the done and cancelled cards that have been closed for `keepMs` and have no running session,
 * and removes the worktree of each that is clean. The branch always stays (`WorktreeManager.remove`),
 * so no commit is lost, and `ensureForTask` makes the worktree again if the card starts anew. A
 * worktree with uncommitted changes is never removed: the owners are told once per closing of the card.
 * What was removed, and about how much space it freed, goes to the server log.
 */
export class WorktreeSweep {
  private readonly mergeCards: MergeCardLock;
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly inbox: InboxService;
  private readonly sessions: Pick<SessionOrchestrator, 'list' | 'isRunning'>;
  private readonly worktrees: WorktreeManager | undefined;
  private readonly engines: EngineDirectory | undefined;
  private readonly disk: Pick<DiskGuard, 'free'>;
  private readonly keepMs: number;

  constructor(deps: {
    mergeCards?: MergeCardLock;
    ctx: DomainContext;
    projects: ProjectService;
    inbox: InboxService;
    /** Sessions are checked again immediately before cleanup. */
    sessions: Pick<SessionOrchestrator, 'list' | 'isRunning'>;
    /** The worktrees of the one machine, when there are no engines. */
    worktrees?: WorktreeManager;
    /** The engines (PM-311): a card's worktree is swept through the engine it is on. */
    engines?: EngineDirectory;
    disk: Pick<DiskGuard, 'free'>;
    keepMs?: number;
  }) {
    this.mergeCards = deps.mergeCards ?? new MergeCardLock();
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.inbox = deps.inbox;
    this.sessions = deps.sessions;
    this.worktrees = deps.worktrees;
    this.engines = deps.engines;
    this.disk = deps.disk;
    this.keepMs = deps.keepMs ?? CLOSED_WORKTREE_KEEP_MS;
  }

  async run(): Promise<WorktreeSweepReport> {
    const report: WorktreeSweepReport = { removed: [], kept: [], freedBytes: null };
    const before = await this.disk.free();
    for (const summary of this.projects.summaries()) {
      const config = this.projects.cachedConfig(summary.key);
      if (!config) continue;
      const managers = this.engines
        ? this.engines.ids().flatMap((id) => {
            const engine = this.engines!.get(id);
            return engine && engine.workspacePath(summary.key) !== null ? [engine] : [];
          })
        : this.worktrees
          ? [{ worktrees: this.worktrees, memberWorkspaces: undefined }]
          : [];
      for (const { worktrees: manager, memberWorkspaces } of managers)
        for (const repo of config.project.repos) {
          try {
            for (const fix of await manager.listMergeFixes({ project: config, repoName: repo.name })) {
              await this.mergeCards.run(summary.key, fix.taskKey, async () => {
                if (this.ctx.repos.taskMerges.open(summary.key, fix.taskKey)) return;
                if (this.ctx.repos.sessionCleanups.forTask(summary.key, fix.taskKey).length) return;
                if (
                  this.sessions
                    .list(summary.key, { taskKey: fix.taskKey })
                    .some(
                      (s) =>
                        (s.cwd === fix.path || s.branch === `merge-fix/${fix.taskKey}`) &&
                        this.sessions.isRunning(s.id),
                    )
                )
                  return;
                await manager.removeMergeFix({ project: config, repoName: repo.name, taskKey: fix.taskKey });
                report.removed.push(`${fix.taskKey}:merge-fix`);
              });
            }
          } catch (err) {
            this.ctx.logger.warn({ err, repo: repo.name }, 'could not sweep merge-fix checkouts');
          }
          try {
            for (const entry of await manager.listTaskWorktrees({ project: config, repoName: repo.name })) {
              const task = this.ctx.repos.tasks.get(entry.taskKey);
              if (!task || task.projectKey !== summary.key || !this.due(task) || this.hasRunningSession(task))
                continue;
              try {
                await this.sweepTask(config, task, entry.path, manager, report);
              } catch (err) {
                this.ctx.logger.warn(
                  { err, taskKey: task.key },
                  'could not clean up the worktree of a closed card',
                );
              }
            }
          } catch (err) {
            this.ctx.logger.warn({ err, repo: repo.name }, 'could not list task worktrees');
          }
          if (memberWorkspaces) {
            try {
              await this.sweepSnapshots(config, repo.name, memberWorkspaces);
            } catch (err) {
              this.ctx.logger.warn({ err, repo: repo.name }, 'could not sweep closed card snapshots');
            }
          }
        }
    }
    const after = report.removed.length > 0 ? await this.disk.free() : null;
    if (before !== null && after !== null) report.freedBytes = Math.max(0, after - before);
    if (report.removed.length > 0 || report.kept.length > 0) {
      this.ctx.logger.info(
        {
          removed: report.removed,
          kept: report.kept,
          freedMb: report.freedBytes === null ? null : Math.round(report.freedBytes / MB),
        },
        'swept the worktrees of closed cards',
      );
    }
    return report;
  }

  /** Whether the card has been closed long enough. */
  private due(task: Task): boolean {
    if (isOpenTask(task) || isTheme(task) || !task.closedAt) return false;
    return this.ctx.now().getTime() - Date.parse(task.closedAt) >= this.keepMs;
  }

  private async sweepSnapshots(config: ProjectConfig, repoName: string, workspaces: MemberWorkspaceManager) {
    const keys = await workspaces.listSnapshotTasks({ project: config, repoName });
    for (let offset = 0; offset < keys.length; offset += SNAPSHOT_BATCH_SIZE) {
      const taskKeys = keys.slice(offset, offset + SNAPSHOT_BATCH_SIZE).filter((key) => {
        const task = this.ctx.repos.tasks.get(key);
        return (
          task &&
          task.projectKey === config.project.key &&
          this.due(task) &&
          !this.hasRunningSession(task) &&
          !this.ctx.repos.taskMerges.open(task.projectKey, task.key)
        );
      });
      if (taskKeys.length) await workspaces.removeTaskSnapshots({ project: config, repoName, taskKeys });
    }
  }

  private async sweepTask(
    config: ProjectConfig,
    task: Task,
    path: string,
    worktrees: WorktreeManager,
    report: WorktreeSweepReport,
  ): Promise<void> {
    const status = await worktrees.status(path);
    // Looked at again right before the removal: the card may have been reopened meanwhile.
    const latest = this.ctx.repos.tasks.get(task.key);
    if (!latest || !this.due(latest) || this.hasRunningSession(latest)) return;
    if (status.dirty) {
      report.kept.push(task.key);
      await this.tellOnce(config, task, path, worktrees);
      return;
    }
    await worktrees.remove({ path });
    report.removed.push(task.key);
  }

  private hasRunningSession(task: Task): boolean {
    if (this.ctx.repos.sessionCleanups.forTask(task.projectKey, task.key).length) return true;
    return this.sessions
      .list(task.projectKey, { taskKey: task.key })
      .some((s) => this.sessions.isRunning(s.id));
  }

  /** One alert per closing of the card: an earlier one (`createdAt` after `closedAt`) says it already. */
  private async tellOnce(
    config: ProjectConfig,
    task: Task,
    path: string,
    worktrees: WorktreeManager,
  ): Promise<void> {
    const owners = ownerHandles(config);
    if (owners.length === 0) return;
    const told = this.inbox
      .list(task.projectKey, { kind: 'alert', taskKey: task.key })
      .some((item) => alertPayloadOf(item)?.alert === 'worktree_kept' && item.createdAt >= task.closedAt!);
    if (told) return;
    const changes = (await worktrees.head(path))?.changes ?? 0;
    const payload: WorktreeKeptAlert = { alert: 'worktree_kept', taskKey: task.key, path, changes };
    this.inbox.create({
      projectKey: task.projectKey,
      kind: 'alert',
      assignees: owners,
      source: 'system',
      taskKey: task.key,
      title: `The worktree of ${task.key} was kept: it has uncommitted changes`,
      payload,
      options: [ALERT_SEEN_OPTION],
    });
  }
}
