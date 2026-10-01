import {
  effectiveRepo,
  isOpenTask,
  isWorkingOnTask,
  roleSessionAccess,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type { AiMemberConfig, ProjectConfig, Session, Task } from '@projectman/shared';
import type {
  MemberWorkspaceInfo,
  MemberWorkspaceKey,
  MemberWorkspaceManager,
  SessionPolicy,
  WorkspaceCheckout,
  WorkspaceSource,
} from '../contracts';
import type { MemberWorkspaceRecord, TaskWorkspaceBinding, WorkspaceHolder } from '../db';
import { taskBranchName } from '../worktree';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { conflict, DomainError } from './errors';
import { KeyedMutex, newId } from './util';

/** Whether a process (or any process of its group) still exists. */
export type ProcessProbe = (pid: number) => boolean;

/** The real probe: signal 0 to the process group, then to the process; EPERM still means it exists. */
export const processExists: ProcessProbe = (pid) => {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 0);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    }
  }
  return false;
};

/** Where a task session works in its member's workspace, as `SessionOrchestrator.start` uses it. */
export interface WorkspacePlacement {
  workspace: MemberWorkspaceRecord;
  binding: TaskWorkspaceBinding;
  info: MemberWorkspaceInfo;
  checkout: WorkspaceCheckout;
  placement: Extract<SessionPolicy['placement'], { kind: 'task_worktree' | 'review_copy' }>;
  /**
   * The conversation of an earlier start belongs to an older generation of the workspace (it was
   * made again or moved): the session must not resume it.
   */
  newGeneration: boolean;
}

export interface MemberWorkspacesDeps {
  ctx: DomainContext;
  manager: MemberWorkspaceManager;
  /** Whether the runner has the session's process. */
  isRunning: (sessionId: string) => boolean;
  /** Stops a running session and records its end (it then releases what it held). */
  stop: (projectKey: string, sessionId: string) => Promise<unknown>;
  processExists?: ProcessProbe;
}

/**
 * Member workspaces (PM-138): one durable, independent clone per project x member x repository,
 * in place of a worktree per task. A task session works there on the task's own branch (`work`) or
 * on a pinned, handed-over commit (`review`, for reviewers and testers).
 *
 * The workspace is reserved by one session at a time, for the whole life of its process and its
 * process group, idle or not (`holder`, kept in SQLite). Every start passes `prepare` (automatic,
 * a person's resume, a message wake-up), and admission asks `check` first. A holder that is not
 * running here and whose process group is gone (proven, e.g. after a restart) no longer holds it;
 * a running holder of another task gives way only when it idles on a task it no longer works on
 * (the stage moved on): it is stopped, its conversation stays. Otherwise the start waits
 * (`workspace_busy`). Switching branches needs a clean workspace (`workspace_dirty`); nothing is
 * ever stashed, reset, cleaned or removed, done and cancelled tasks included.
 */
export class MemberWorkspaces {
  private readonly ctx: DomainContext;
  private readonly manager: MemberWorkspaceManager;
  private readonly deps: MemberWorkspacesDeps;
  private readonly alive: ProcessProbe;
  private readonly locks = new KeyedMutex();
  /** Sessions between `prepare` and their process start (or failure): they hold their workspace. */
  private readonly starting = new Set<string>();

  constructor(deps: MemberWorkspacesDeps) {
    this.ctx = deps.ctx;
    this.manager = deps.manager;
    this.deps = deps;
    this.alive = deps.processExists ?? processExists;
  }

  /**
   * How the member works on the task in its workspace: `work` (the task's branch) for a role that
   * changes files, unless it is a reviewer or tester of a later stage who is not the assignee;
   * `review` for review and testing duties; null for roles that only read, or without a repository.
   */
  kindFor(config: ProjectConfig, member: AiMemberConfig, task: Task): 'work' | 'review' | null {
    if (!effectiveRepo(config, task)) return null;
    const access = roleSessionAccess(config, member.role);
    if (access.worktree) {
      const stage = stageOf(config, task.stageId);
      const reviewing =
        access.reviewCopy &&
        task.assignee !== member.handle &&
        stage !== undefined &&
        (stage.kind === 'step' || stage.kind === 'release') &&
        stageOwners(config, stage).includes(member.handle);
      return reviewing ? 'review' : 'work';
    }
    return access.reviewCopy ? 'review' : null;
  }

  /** Admission: refuses with `workspace_busy` while another task's live session holds the workspace. */
  check(config: ProjectConfig, member: AiMemberConfig, task: Task): void {
    if (!this.kindFor(config, member, task)) return;
    const repo = effectiveRepo(config, task)!;
    const record = this.ctx.repos.memberWorkspaces.find(config.project.key, member.handle, repo);
    const holder = record?.holder;
    if (!holder || holder.taskKey === task.key || !this.holds(holder)) return;
    if (this.yieldingSession(config, holder)) return;
    throw this.busy(member.handle, repo, holder);
  }

  /**
   * Reserves the workspace for the session and puts it where the task needs it, creating the
   * workspace the first time. The caller reports the started process (`started`) or the failure
   * (`ended`).
   */
  async prepare(
    config: ProjectConfig,
    member: AiMemberConfig,
    task: Task,
    sessionId: string,
  ): Promise<WorkspacePlacement> {
    const kind = this.kindFor(config, member, task);
    const repo = effectiveRepo(config, task);
    if (!kind || !repo) throw new Error('the member has no workspace for this task');
    const projectKey = config.project.key;
    const key: MemberWorkspaceKey = { project: config, repoName: repo, member: member.handle };
    return this.locks.run(`${projectKey}:${member.handle}:${repo}`, async () => {
      const store = this.ctx.repos.memberWorkspaces;
      let record = store.find(projectKey, member.handle, repo);
      // The reservation comes first: nothing touches a workspace another task's process uses.
      if (record) await this.acquire(config, record, sessionId, task.key);
      this.starting.add(sessionId);
      try {
        const info = await this.manager.ensure(key).catch((err: unknown) => {
          throw toDomainError(err, member.handle);
        });
        if (!record) {
          store.insert({
            id: newId('wsp'),
            projectKey,
            member: member.handle,
            repo,
            path: info.path,
            generation: 1,
            createdAt: isoNow(this.ctx),
          });
          record = store.find(projectKey, member.handle, repo)!;
          this.hold(record, sessionId, task.key);
        } else if (info.created || record.path !== info.path) {
          // Made again (it was gone) or moved: older conversations do not belong to it.
          store.relocate(record.id, info.path, record.generation + 1);
          this.ctx.logger.warn(
            { member: member.handle, repo, path: info.path, generation: record.generation + 1 },
            'member workspace made again; earlier conversations start anew',
          );
        }
        record = store.get(record.id)!;
        const previous = store.binding(projectKey, task.key, member.handle, record.id);
        const prepared =
          kind === 'work'
            ? await this.prepareWork(config, key, task, record, previous)
            : await this.prepareReview(config, key, task, record, previous);
        const now = isoNow(this.ctx);
        const binding: TaskWorkspaceBinding = {
          ...prepared.binding,
          projectKey,
          taskKey: task.key,
          member: member.handle,
          workspaceId: record.id,
          generation: record.generation,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        };
        store.saveBinding(binding);
        return {
          workspace: record,
          binding,
          info,
          checkout: prepared.checkout,
          placement: prepared.placement(info, binding),
          newGeneration: previous !== null && previous.generation !== record.generation,
        };
      } catch (err) {
        this.ended(sessionId);
        throw toDomainError(err, member.handle);
      }
    });
  }

  /** The session's process started: its process group now holds the workspace. */
  started(sessionId: string, pid: number): void {
    this.starting.delete(sessionId);
    for (const record of this.ctx.repos.memberWorkspaces.heldBy(sessionId))
      this.ctx.repos.memberWorkspaces.setHolderPid(record.id, sessionId, pid);
  }

  /**
   * The session ended or did not start: its workspaces are free once its process group is gone.
   * Processes it left running keep the workspace until they are gone too.
   */
  ended(sessionId: string): void {
    this.starting.delete(sessionId);
    for (const record of this.ctx.repos.memberWorkspaces.heldBy(sessionId)) {
      if (this.deps.isRunning(sessionId)) continue;
      const pid = record.holder?.pid ?? null;
      if (pid !== null && this.alive(pid)) {
        this.ctx.logger.warn(
          { sessionId, pid, member: record.member, repo: record.repo },
          'processes of an ended session still run; its workspace stays reserved',
        );
        continue;
      }
      this.ctx.repos.memberWorkspaces.release(record.id, sessionId);
    }
  }

  /**
   * A running review session whose round is over (the task entered a stage, its developer asked
   * for a re-review): it is restarted on the new commit the next time it is needed, so it is not
   * handed messages as it is. Only while it idles; a turn in progress finishes first.
   */
  isStale(session: Session): boolean {
    if (session.workItem.type !== 'task' || session.state !== 'idle') return false;
    return this.ctx.repos.memberWorkspaces
      .bindingsOfTask(session.projectKey, session.workItem.taskKey)
      .some((b) => b.member === session.member && b.kind === 'review' && b.refresh);
  }

  /** A new review round is due: for every reviewer of the task, or for one member. */
  requestReviewRound(projectKey: string, taskKey: string, member?: string): void {
    this.ctx.repos.memberWorkspaces.requestReviewRound(projectKey, taskKey, member);
  }

  /** Whether the member has a review binding for the task (a re-review request concerns it). */
  reviews(projectKey: string, taskKey: string, member: string): boolean {
    return this.ctx.repos.memberWorkspaces
      .bindingsOfTask(projectKey, taskKey)
      .some((b) => b.member === member && b.kind === 'review');
  }

  /** The workspace where the task's committed work was last made (for readers and reviewers). */
  workSource(
    projectKey: string,
    taskKey: string,
    exceptMember?: string,
  ): (WorkspaceSource & { path: string }) | null {
    const work = this.ctx.repos.memberWorkspaces
      .bindingsOfTask(projectKey, taskKey)
      .filter((b) => b.kind === 'work' && b.branch && b.member !== exceptMember)
      .at(-1);
    const record = work ? this.ctx.repos.memberWorkspaces.get(work.workspaceId) : null;
    return work && record ? { path: record.path, ref: `refs/heads/${work.branch}` } : null;
  }

  /** Whether a directory is a member workspace (never removed when a task is done). */
  isWorkspacePath(dir: string): boolean {
    return this.ctx.repos.memberWorkspaces.findByPath(dir) !== null;
  }

  private async prepareWork(
    config: ProjectConfig,
    key: MemberWorkspaceKey,
    task: Task,
    record: MemberWorkspaceRecord,
    previous: TaskWorkspaceBinding | null,
  ) {
    let checkout: WorkspaceCheckout | null = null;
    let baseCommit: string | null = null;
    let sourceCommit: string | null = null;
    if (previous?.kind === 'work' && previous.branch) {
      // Continuing: the task's branch as the member left it, never reset or rebased.
      checkout = await this.manager.checkoutTaskBranch(key, { mode: 'continue', branch: previous.branch });
      baseCommit = previous.baseCommit;
      sourceCommit = previous.sourceCommit;
    }
    if (!checkout) {
      // Taken over from a teammate: their committed branch.
      const teammate = this.workSource(config.project.key, task.key, key.member);
      const commit = teammate ? await this.manager.resolveSource(teammate) : null;
      if (teammate && commit) {
        const branch = teammate.ref.slice('refs/heads/'.length);
        checkout = await this.manager.checkoutTaskBranch(key, { mode: 'fetch', branch, source: teammate });
        sourceCommit = commit;
      }
    }
    if (!checkout) {
      // A branch of the task already in the workspace, or in the project repository (a worktree's).
      const wanted = taskBranchNameOf(task);
      const found = await this.manager.findTaskBranch(key, task.key, wanted);
      if (found) {
        checkout = await this.manager.checkoutTaskBranch(
          key,
          found.source
            ? { mode: 'fetch', branch: found.branch, source: found.source }
            : { mode: 'continue', branch: found.branch },
        );
        sourceCommit = found.source ? checkout.head : null;
      } else {
        // A new task: its own branch from the freshly fetched default branch.
        const base = await this.manager.fetchBase(key);
        checkout = await this.manager.checkoutTaskBranch(key, {
          mode: 'create',
          branch: wanted,
          startPoint: base.commit,
        });
        baseCommit = base.commit;
      }
    }
    const branch = checkout.branch!;
    this.ctx.logger.debug(
      { member: key.member, taskKey: task.key, branch, workspace: record.id },
      'workspace ready',
    );
    return {
      checkout,
      binding: {
        kind: 'work' as const,
        branch,
        baseCommit,
        sourcePath: null,
        sourceRef: null,
        sourceCommit,
        round: 0,
        refresh: false,
      },
      placement: (info: MemberWorkspaceInfo): WorkspacePlacement['placement'] => ({
        kind: 'task_worktree',
        path: info.path,
        workspace: { branch, baseCommit },
      }),
    };
  }

  private async prepareReview(
    config: ProjectConfig,
    key: MemberWorkspaceKey,
    task: Task,
    record: MemberWorkspaceRecord,
    previous: TaskWorkspaceBinding | null,
  ) {
    const sameRound =
      previous?.kind === 'review' &&
      !previous.refresh &&
      previous.sourcePath !== null &&
      previous.sourceRef !== null &&
      previous.sourceCommit !== null;
    let binding: Omit<
      TaskWorkspaceBinding,
      'projectKey' | 'taskKey' | 'member' | 'workspaceId' | 'generation' | 'createdAt' | 'updatedAt'
    >;
    let checkout: WorkspaceCheckout;
    if (sameRound) {
      // Continuing the round: the same pinned commit.
      checkout = await this.manager.checkoutReview(
        key,
        { path: previous.sourcePath!, ref: previous.sourceRef! },
        previous.sourceCommit!,
      );
      binding = { ...previous, kind: 'review' };
    } else {
      // A new round: the handed-over branch's commit now, and the default branch now.
      const source = await this.reviewSource(key, task);
      const commit = source ? await this.manager.resolveSource(source) : null;
      if (!source || !commit)
        throw conflict('workspace_source_missing', `task ${task.key} has no committed branch to review yet`, {
          taskKey: task.key,
        });
      const base = await this.manager.fetchBase(key);
      checkout = await this.manager.checkoutReview(key, source, commit);
      binding = {
        kind: 'review',
        branch: null,
        baseCommit: base.commit,
        sourcePath: source.path,
        sourceRef: source.ref,
        sourceCommit: commit,
        round: (previous?.kind === 'review' ? previous.round : 0) + 1,
        refresh: false,
      };
      this.ctx.logger.info(
        { member: key.member, taskKey: task.key, round: binding.round, commit, workspace: record.id },
        'review round pinned',
      );
    }
    const sourceBranch = binding.sourceRef!.replace(/^refs\/(heads|remotes\/origin)\//, '');
    const baseBranch = config.project.repos.find((r) => r.name === key.repoName)?.defaultBranch;
    return {
      checkout,
      binding,
      placement: (
        info: MemberWorkspaceInfo,
        saved: TaskWorkspaceBinding,
      ): WorkspacePlacement['placement'] => ({
        kind: 'review_copy',
        path: info.path,
        gitDir: info.gitDir,
        sourceCommit: saved.sourceCommit!,
        roundId: String(saved.round),
        cacheDir: info.cacheDir,
        tempDir: info.tempDir,
        sourceBranch,
        ...(baseBranch ? { baseBranch } : {}),
        ...(saved.baseCommit ? { baseCommit: saved.baseCommit } : {}),
      }),
    };
  }

  /** Where the task's handed-over work is: a developer's workspace, else a branch of the repository. */
  private async reviewSource(key: MemberWorkspaceKey, task: Task): Promise<WorkspaceSource | null> {
    const teammate = this.workSource(key.project.project.key, task.key, key.member);
    if (teammate) return teammate;
    const found = await this.manager.findTaskBranch(key, task.key);
    if (!found) return null;
    return (
      found.source ?? { path: (await this.manager.location(key)).path, ref: `refs/heads/${found.branch}` }
    );
  }

  /** Takes the reservation for the session, or refuses (`workspace_busy`). */
  private async acquire(
    config: ProjectConfig,
    record: MemberWorkspaceRecord,
    sessionId: string,
    taskKey: string,
  ): Promise<void> {
    const holder = record.holder;
    if (holder && holder.sessionId !== sessionId && this.holds(holder)) {
      const yielding = this.yieldingSession(config, holder);
      if (!yielding) throw this.busy(record.member, record.repo, holder);
      this.ctx.logger.info(
        { member: record.member, repo: record.repo, from: holder.taskKey, to: taskKey },
        'stopping an idle session that moved on, to switch its workspace to another task',
      );
      await this.deps.stop(record.projectKey, yielding.id);
      const after = this.ctx.repos.memberWorkspaces.get(record.id)?.holder;
      if (after && after.sessionId !== sessionId && this.holds(after))
        throw this.busy(record.member, record.repo, after);
    }
    this.hold(record, sessionId, taskKey);
  }

  private hold(record: MemberWorkspaceRecord, sessionId: string, taskKey: string): void {
    const holder: WorkspaceHolder = { sessionId, taskKey, pid: null, since: isoNow(this.ctx) };
    this.ctx.repos.memberWorkspaces.hold(record.id, holder);
  }

  /** Whether the holder's process still holds the workspace (proven gone otherwise). */
  private holds(holder: WorkspaceHolder): boolean {
    if (this.starting.has(holder.sessionId) || this.deps.isRunning(holder.sessionId)) return true;
    return holder.pid !== null && this.alive(holder.pid);
  }

  /**
   * The holder's running session when it may be stopped for another task: it idles (no turn,
   * no question pending) on a task that is closed or that the member no longer works on.
   */
  private yieldingSession(config: ProjectConfig, holder: WorkspaceHolder): Session | null {
    if (!this.deps.isRunning(holder.sessionId)) return null;
    const session = this.ctx.repos.sessions.get(holder.sessionId);
    if (!session || session.state !== 'idle') return null;
    const task = this.ctx.repos.tasks.get(holder.taskKey);
    if (task && isOpenTask(task) && isWorkingOnTask(config, task, session.member, session.state)) return null;
    return session;
  }

  private busy(member: string, repo: string, holder: WorkspaceHolder): DomainError {
    return conflict(
      'workspace_busy',
      `the workspace of ${member} for ${repo} is in use by task ${holder.taskKey}`,
      { member, repo, taskKey: holder.taskKey, sessionId: holder.sessionId },
    );
  }
}

function taskBranchNameOf(task: Task): string {
  return taskBranchName(task.key, task.title);
}

/** The workspace manager's refusals as domain errors (see `MemberWorkspaceErrorCode`). */
function toDomainError(err: unknown, member: string): DomainError {
  if (err instanceof DomainError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const details = { member, ...((err as { details?: Record<string, unknown> } | null)?.details ?? {}) };
  const message = (err as Error).message;
  switch (code) {
    case 'workspace_dirty':
      return conflict('workspace_dirty', message, details);
    case 'workspace_fetch_failed':
      return conflict('workspace_fetch_failed', message, details);
    case 'workspace_branch_missing':
      return conflict('workspace_branch_missing', message, details);
    case 'workspace_source_missing':
      return conflict('workspace_source_missing', message, details);
    default:
      return new DomainError('session_start_failed', `could not prepare the workspace: ${message}`, {
        status: 502,
        details: { stage: 'workspace', reason: typeof code === 'string' ? code : null },
      });
  }
}
