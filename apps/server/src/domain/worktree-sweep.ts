import { ALERT_SEEN_OPTION, alertPayloadOf, effectiveRepo, isOpenTask, isTheme } from '@projectman/shared';
import type { ProjectConfig, Task, WorktreeKeptAlert } from '@projectman/shared';
import type { WorktreeManager } from '../contracts';
import { ownerHandles } from './access';
import type { DomainContext } from './context';
import type { DiskGuard } from './disk-guard';
import type { InboxService } from './inbox';
import type { ProjectService } from './projects';
import type { SessionOrchestrator } from './sessions';

/** A closed card's worktree stays this long: a done card may come back, and the developer may look again. */
export const CLOSED_WORKTREE_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

const MB = 1024 ** 2;

export interface WorktreeSweepReport {
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
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly inbox: InboxService;
  private readonly sessions: Pick<SessionOrchestrator, 'list' | 'isRunning'>;
  private readonly worktrees: WorktreeManager;
  private readonly disk: Pick<DiskGuard, 'free'>;
  private readonly keepMs: number;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    inbox: InboxService;
    sessions: Pick<SessionOrchestrator, 'list' | 'isRunning'>;
    worktrees: WorktreeManager;
    disk: Pick<DiskGuard, 'free'>;
    keepMs?: number;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.inbox = deps.inbox;
    this.sessions = deps.sessions;
    this.worktrees = deps.worktrees;
    this.disk = deps.disk;
    this.keepMs = deps.keepMs ?? CLOSED_WORKTREE_KEEP_MS;
  }

  async run(): Promise<WorktreeSweepReport> {
    const report: WorktreeSweepReport = { removed: [], kept: [], freedBytes: null };
    const before = await this.disk.free();
    for (const summary of this.projects.summaries()) {
      const config = this.projects.cachedConfig(summary.key);
      if (!config) continue;
      for (const task of this.ctx.repos.tasks.list(summary.key)) {
        if (!this.due(task)) continue;
        try {
          await this.sweepTask(config, task, report);
        } catch (err) {
          this.ctx.logger.warn(
            { err, taskKey: task.key },
            'could not clean up the worktree of a closed card',
          );
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

  private async sweepTask(config: ProjectConfig, task: Task, report: WorktreeSweepReport): Promise<void> {
    const repoName = effectiveRepo(config, task);
    if (!repoName) return;
    if (this.hasRunningSession(task)) return;
    const found = await this.worktrees.find({ project: config, repoName, taskKey: task.key });
    if (!found) return;
    const status = await this.worktrees.status(found.path);
    // Looked at again right before the removal: the card may have been reopened meanwhile.
    const latest = this.ctx.repos.tasks.get(task.key);
    if (!latest || !this.due(latest) || this.hasRunningSession(latest)) return;
    if (status.dirty) {
      report.kept.push(task.key);
      await this.tellOnce(config, task, found.path);
      return;
    }
    await this.worktrees.remove({ path: found.path });
    report.removed.push(task.key);
  }

  private hasRunningSession(task: Task): boolean {
    return this.sessions
      .list(task.projectKey, { taskKey: task.key })
      .some((s) => this.sessions.isRunning(s.id));
  }

  /** One alert per closing of the card: an earlier one (`createdAt` after `closedAt`) says it already. */
  private async tellOnce(config: ProjectConfig, task: Task, path: string): Promise<void> {
    const owners = ownerHandles(config);
    if (owners.length === 0) return;
    const told = this.inbox
      .list(task.projectKey, { kind: 'alert', taskKey: task.key })
      .some((item) => alertPayloadOf(item)?.alert === 'worktree_kept' && item.createdAt >= task.closedAt!);
    if (told) return;
    const changes = (await this.worktrees.head(path))?.changes ?? 0;
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
