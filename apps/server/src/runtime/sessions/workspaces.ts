import {
  effectiveRepo,
  isMergeFixer,
  isOpenTask,
  isWorkingOnTask,
  roleSessionAccess,
  memberDuties,
  memberOf,
  memberStorageHandle,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type { AiMemberConfig, ProjectConfig, Session, Task } from '@projectman/shared';
import type {
  ProcessProbe,
  SessionCleanup,
  MemberWorkspaceInfo,
  MemberWorkspaceKey,
  MemberWorkspaceManager,
  SessionPolicy,
  SourceHead,
  WorkspaceCheckout,
  WorkspaceSource,
} from '../../contracts';
import { isEngineLinkLost } from '../../contracts';
import type { MemberWorkspaceRecord, TaskWorkspaceBinding, WorkspaceHolder } from '../../db';
import { taskBranchName } from '@projectman/shared';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import { conflict, DomainError } from '../../kernel';
import { KeyedMutex, newId } from '../../kernel';

/** The default branch as `MemberWorkspaceManager.fetchBase` leaves it in the workspace. */
type FetchedBase = Awaited<ReturnType<MemberWorkspaceManager['fetchBase']>>;

/** The refs of commits a developer's workspace handed over to the project repository (PM-739). */
const SNAPSHOT_REF_PREFIX = 'refs/projectman/workspaces/';
/** Where `MemberWorkspaceManager.fetchBase` leaves the default branch in the member's own clone. */
const BASE_TRACKING_REF_PREFIX = 'refs/remotes/upstream/';
const WORKSPACE_YIELD_IDLE_MS = 2 * 60_000;

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

interface MemberWorkspacesDeps {
  ctx: DomainContext;
  manager: MemberWorkspaceManager;
  /** Whether the runner has the session's process. */
  isRunning: (sessionId: string) => boolean;
  /** Stops a running session and records its end (it then releases what it held). */
  stop: (projectKey: string, sessionId: string) => Promise<unknown>;
  processExists: ProcessProbe;
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
    this.alive = deps.processExists;
  }

  /**
   * How the member works on the task in its workspace: `work` (the task's branch) for a role that
   * changes files, unless it is a reviewer or tester of a later stage who is not the assignee;
   * `review` also for a designer without implementation duties inspecting another member's work;
   * null for roles that only read, or without a repository.
   */
  kindFor(config: ProjectConfig, member: AiMemberConfig, task: Task): 'work' | 'review' | null {
    if (!effectiveRepo(config, task)) return null;
    const access = roleSessionAccess(config, member.role);
    if (access.worktree) {
      if (this.isDesignReview(config, member, task)) return 'review';
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

  private isDesignReview(config: ProjectConfig, member: AiMemberConfig, task: Task): boolean {
    const duties = memberDuties(config, member);
    return (
      task.assignee !== member.handle &&
      duties.includes('ux_design') &&
      !duties.includes('implementation') &&
      this.workOf(config.project.key, task.key, member.handle) !== null
    );
  }

  /** Admission: refuses with `workspace_busy` while another task's live session holds the workspace. */
  check(config: ProjectConfig, member: AiMemberConfig, task: Task): void {
    if (isMergeFixer(task.merge, member.handle)) return;
    if (!this.kindFor(config, member, task)) return;
    const repo = effectiveRepo(config, task)!;
    const record = this.ctx.repos.memberWorkspaces.find(
      config.project.key,
      memberStorageHandle(member),
      repo,
    );
    const holder = record?.holder;
    if (holder?.cleanupFailed) throw this.busy(member.handle, repo, holder);
    if (!holder || holder.taskKey === task.key || !this.holds(holder)) return;
    if (this.yieldingSession(config, holder, task.key)) return;
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
    // The workspace is kept under the storage handle, which a rename of the member does not change.
    const storage = memberStorageHandle(member);
    const key: MemberWorkspaceKey = { project: config, repoName: repo, member: storage };
    return this.locks.run(`${projectKey}:${member.handle}:${repo}`, async () => {
      const store = this.ctx.repos.memberWorkspaces;
      let record = store.find(projectKey, storage, repo);
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
            member: storage,
            repo,
            path: info.path,
            generation: 1,
            createdAt: isoNow(this.ctx),
          });
          record = store.find(projectKey, storage, repo)!;
          this.hold(record, sessionId, task.key);
        } else if (info.created || record.path !== info.path) {
          // Made again (it was gone) or moved: older conversations do not belong to it.
          store.relocate(record.id, info.path, record.generation + 1);
          this.ctx.logger.warn(
            { member: storage, repo, path: info.path, generation: record.generation + 1 },
            'member workspace made again; earlier conversations start anew',
          );
        }
        record = store.get(record.id)!;
        const previous = store.binding(projectKey, task.key, member.handle, record.id);
        // Every start, new or continued, begins from a fresh default branch (PM-740): the one fetch of
        // this preparation, before anything is checked out. A failed fetch ends the start.
        const base = await this.manager.fetchBase(key);
        const prepared =
          kind === 'work'
            ? await this.prepareWork(config, member, key, task, record, previous, base)
            : await this.prepareReview(config, member, key, task, record, previous, base);
        await this.manager.prepareDependencies(key);
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
  started(sessionId: string, pid: number, scopeId?: string): void {
    this.starting.delete(sessionId);
    for (const record of this.ctx.repos.memberWorkspaces.heldBy(sessionId))
      this.ctx.repos.memberWorkspaces.setHolderPid(record.id, sessionId, pid, scopeId);
  }

  /**
   * The session ended or did not start: its workspaces are free once its process group is gone.
   * Processes it left running keep the workspace until they are gone too.
   */
  ended(sessionId: string, cleanup?: SessionCleanup): void {
    this.starting.delete(sessionId);
    for (const record of this.ctx.repos.memberWorkspaces.heldBy(sessionId)) {
      if (cleanup && record.holder?.scopeId !== cleanup.scopeId) continue;
      if (cleanup?.outcome === 'failed') {
        this.ctx.repos.memberWorkspaces.failCleanup(record.id, sessionId, cleanup.scopeId);
        continue;
      }
      if (cleanup?.outcome === 'clean') {
        this.ctx.repos.memberWorkspaces.release(record.id, sessionId);
        continue;
      }
      if (record.holder?.cleanupFailed) continue;
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
    return session.state === 'idle' && this.roundDue(session);
  }

  /**
   * The session's review round is over, whatever it is doing now. Messages for a session that is
   * still in a turn wait (they are not typed into the old round) until it idles and restarts.
   */
  roundDue(session: Session): boolean {
    if (session.workItem.type !== 'task' || !this.isWorkspacePath(session.cwd)) return false;
    return this.ctx.repos.memberWorkspaces
      .bindingsOfTask(session.projectKey, session.workItem.taskKey)
      .some((b) => b.member === session.member && b.refresh);
  }

  /** A new review round is due: for every reviewer of the task, or for one member. */
  requestReviewRound(projectKey: string, taskKey: string, member?: string, config?: ProjectConfig): void {
    this.ctx.repos.memberWorkspaces.requestReviewRound(projectKey, taskKey, member);
    // A designer may still be running in the writable workspace used for planning. Mark it
    // for a restart too; prepare will move it to a review copy after the current turn finishes.
    const task = this.ctx.repos.tasks.get(taskKey);
    if (!config || !task || task.projectKey !== projectKey) return;
    for (const binding of this.ctx.repos.memberWorkspaces.bindingsOfTask(projectKey, taskKey)) {
      if (binding.kind !== 'work' || (member && binding.member !== member)) continue;
      const reviewer = memberOf(config, binding.member);
      if (reviewer?.kind === 'ai' && this.kindFor(config, reviewer, task) === 'review')
        this.ctx.repos.memberWorkspaces.saveBinding({ ...binding, refresh: true });
    }
  }

  /**
   * Brings the default branch of the member's workspace for the task up to date without starting
   * anything (PM-740): a developer's running session is about to be told by a reviewer, e.g. to merge
   * main. Only tracking refs (and a fast-forward of an unused own default branch) move: the checkout,
   * the task branch, its files and the binding's pins stay as they are, and the reservation is kept.
   * Without a workspace of the member for the task it does nothing; a failed fetch throws.
   */
  async refreshBase(config: ProjectConfig, task: Task, member: string): Promise<void> {
    const binding = this.ctx.repos.memberWorkspaces
      .bindingsOfTask(config.project.key, task.key)
      .find((b) => b.member === member && b.kind === 'work');
    const record = binding ? this.ctx.repos.memberWorkspaces.get(binding.workspaceId) : null;
    if (!record) return;
    const key: MemberWorkspaceKey = { project: config, repoName: record.repo, member: record.member };
    await this.manager.fetchBase(key).catch((err: unknown) => {
      throw toDomainError(err, member);
    });
  }

  /**
   * The workspace that holds the task's committed work, for readers, reviewers and a developer who
   * takes it over: the assignee's, whoever else opened the task since (another developer's copy
   * may be stale); without one, the most recently used other copy (the previous assignee's).
   */
  workSource(projectKey: string, taskKey: string, exceptMember?: string): WorkspaceSource | null {
    const work = this.workOf(projectKey, taskKey, exceptMember);
    return work ? { path: work.record.path, ref: `refs/heads/${work.binding.branch}` } : null;
  }

  /**
   * The head of the task's branch in the developer's workspace (see `workSource`) and whether that
   * workspace has uncommitted work on it (PM-183); null when nobody has worked on the task here.
   */
  async sourceHead(config: ProjectConfig, task: Task): Promise<SourceHead | null> {
    const work = this.workOf(config.project.key, task.key);
    if (!work?.binding.branch) return null;
    const key = { project: config, repoName: work.record.repo, member: work.record.member };
    return this.manager.sourceHead(key, work.binding.branch);
  }

  /**
   * The developer's workspace (see `workSource`) for a reader to look into, only while it has the
   * task's branch checked out: once the developer moved on to another task, it shows other files.
   */
  async readableWork(config: ProjectConfig, taskKey: string): Promise<string | null> {
    const work = this.workOf(config.project.key, taskKey);
    if (!work) return null;
    const key = { project: config, repoName: work.record.repo, member: work.record.member };
    const status = await this.manager.status(key).catch((err: unknown) => {
      this.ctx.logger.warn(
        { err, taskKey, member: work.record.member },
        'could not read the developer workspace',
      );
      return null;
    });
    return status?.checkout?.branch === work.binding.branch ? work.record.path : null;
  }

  private workOf(projectKey: string, taskKey: string, exceptMember?: string) {
    const works = this.ctx.repos.memberWorkspaces
      .bindingsOfTask(projectKey, taskKey)
      .filter((b) => b.kind === 'work' && b.branch && b.member !== exceptMember);
    const task = this.ctx.repos.tasks.get(taskKey);
    const assignee = task?.projectKey === projectKey ? task.assignee : null;
    const binding = works.find((b) => assignee !== null && b.member === assignee) ?? works.at(-1);
    const record = binding ? this.ctx.repos.memberWorkspaces.get(binding.workspaceId) : null;
    return binding && record ? { binding, record } : null;
  }

  /** Whether a directory is a member workspace (never removed when a task is done). */
  isWorkspacePath(dir: string): boolean {
    return this.ctx.repos.memberWorkspaces.findByPath(dir) !== null;
  }

  private async prepareWork(
    config: ProjectConfig,
    member: AiMemberConfig,
    key: MemberWorkspaceKey,
    task: Task,
    record: MemberWorkspaceRecord,
    previous: TaskWorkspaceBinding | null,
    base: FetchedBase,
  ) {
    let checkout: WorkspaceCheckout | null = null;
    let baseCommit: string | null = null;
    let sourceCommit: string | null = null;
    /** The refusal of a branch that went with a workspace made again, if it is not found elsewhere. */
    let lost: unknown = null;
    if (previous?.kind === 'work' && previous.branch) {
      // Continuing: the task's branch as the member left it, never reset or rebased.
      try {
        checkout = await this.manager.checkoutTaskBranch(key, { mode: 'continue', branch: previous.branch });
        baseCommit = previous.baseCommit;
        sourceCommit = previous.sourceCommit;
      } catch (err) {
        // A workspace made again lost its local branches: the task's committed work is looked for
        // where else it may be (a teammate, the project repository) below. In the same workspace a
        // missing branch is reported, never started over.
        const missing = (err as { code?: unknown }).code === 'workspace_branch_missing';
        if (!missing || previous.generation === record.generation) throw err;
        lost = err;
        this.ctx.logger.warn(
          { member: key.member, taskKey: task.key, branch: previous.branch },
          'the task branch is gone with the old workspace; looking for it elsewhere',
        );
      }
    }
    if (!checkout) {
      // Taken over from a teammate: their committed branch (the assignee's first).
      const teammate = this.workSource(config.project.key, task.key, member.handle);
      const commit = teammate ? await this.manager.resolveSource(teammate) : null;
      if (teammate && commit) {
        const branch = teammate.ref.slice('refs/heads/'.length);
        checkout = await this.manager.checkoutTaskBranch(key, { mode: 'fetch', branch, source: teammate });
        // A branch of that name already here is kept as it is (never overwritten): what is checked
        // out is what the binding records.
        sourceCommit = checkout.head;
        if (checkout.head !== commit)
          this.ctx.logger.warn(
            { member: key.member, taskKey: task.key, branch, local: checkout.head, teammate: commit },
            "kept the member's own branch, which differs from the teammate's",
          );
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
      } else if (lost) {
        // The task had a branch: it is not started over from the default branch.
        throw lost;
      } else {
        // A new task: its own branch from the default branch fetched for this start.
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
    member: AiMemberConfig,
    key: MemberWorkspaceKey,
    task: Task,
    record: MemberWorkspaceRecord,
    previous: TaskWorkspaceBinding | null,
    base: FetchedBase,
  ) {
    // Design review can start in the work stage, before any stage hand-over pin exists.
    // Every actual start inspects the current developer tip, including a manual resume.
    const designSource = this.isDesignReview(config, member, task)
      ? await this.reviewSource(config, member, key, task)
      : null;
    const sameRound =
      previous?.kind === 'review' &&
      !previous.refresh &&
      (!designSource || designSource.commit === previous.sourceCommit) &&
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
      // A new round: the handed-over branch's commit now, and the default branch fetched for this start.
      // A card with no branch yet (one being worked out) is read on the fetched default branch.
      const selected = designSource ??
        (await this.reviewSource(config, member, key, task)) ?? {
          source: { path: record.path, ref: `${BASE_TRACKING_REF_PREFIX}${base.branch}` },
          commit: base.commit,
        };
      const { source, commit } = selected;
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
    const sourceBranch = this.sourceBranchOf(task, binding.sourceRef!);
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

  /**
   * Where the task's handed-over work is and the commit of a new round: the developer's committed
   * branch tip, handed over to the project repository as a snapshot that stays as it is while the
   * developer goes on (PM-739); else a branch of the repository.
   */
  private async reviewSource(
    config: ProjectConfig,
    member: AiMemberConfig,
    key: MemberWorkspaceKey,
    task: Task,
  ): Promise<{ source: WorkspaceSource; commit: string } | null> {
    const work = this.workOf(key.project.project.key, task.key, member.handle);
    if (work) {
      const commit = await this.manager.resolveSource({
        path: work.record.path,
        ref: `refs/heads/${work.binding.branch}`,
      });
      if (!commit) return null;
      const source = await this.manager.publishTaskBranch(
        { project: config, repoName: work.record.repo, member: work.record.member },
        task.key,
        work.binding.branch!,
        commit,
      );
      return { source, commit };
    }
    const found = await this.manager.findTaskBranch(key, task.key);
    if (!found) return null;
    const source = found.source ?? {
      path: (await this.manager.location(key)).path,
      ref: `refs/heads/${found.branch}`,
    };
    const commit = await this.manager.resolveSource(source);
    return commit ? { source, commit } : null;
  }

  /** The branch name a review shows: a snapshot's is the developer's branch, not its internal ref. */
  private sourceBranchOf(task: Task, ref: string): string {
    if (ref.startsWith(BASE_TRACKING_REF_PREFIX)) return ref.slice(BASE_TRACKING_REF_PREFIX.length);
    if (!ref.startsWith(SNAPSHOT_REF_PREFIX)) return ref.replace(/^refs\/(heads|remotes\/origin)\//, '');
    return this.workOf(task.projectKey, task.key)?.binding.branch ?? taskBranchNameOf(task);
  }

  /**
   * Makes the approved commit of a merge readable in the project repository (PM-739): the
   * developer's workspace hands over its committed branch, once, as a snapshot (a snapshot that is
   * there already changes nothing). Without a developer workspace of the task the commit is
   * expected in the repository already. Never another branch's commit instead.
   */
  async prepareMergeSource(config: ProjectConfig, task: Task, commit: string): Promise<void> {
    const work = this.workOf(config.project.key, task.key);
    if (!work?.binding.branch) return;
    const key = { project: config, repoName: work.record.repo, member: work.record.member };
    await this.manager.publishTaskBranch(key, task.key, work.binding.branch, commit).catch((err: unknown) => {
      if (isEngineLinkLost(err)) throw err;
      throw toDomainError(err, work.record.member);
    });
  }

  /** Takes the reservation for the session, or refuses (`workspace_busy`). */
  private async acquire(
    config: ProjectConfig,
    record: MemberWorkspaceRecord,
    sessionId: string,
    taskKey: string,
  ): Promise<void> {
    const holder = record.holder;
    if (holder?.cleanupFailed) throw this.busy(record.member, record.repo, holder);
    if (holder && holder.sessionId !== sessionId && this.holds(holder)) {
      const yielding = this.yieldingSession(config, holder, taskKey);
      if (!yielding) throw this.busy(record.member, record.repo, holder);
      this.ctx.logger.info(
        { member: record.member, repo: record.repo, from: holder.taskKey, to: taskKey },
        'stopping an idle session to switch its workspace to another task',
      );
      await this.deps.stop(record.projectKey, yielding.id);
      const after = this.ctx.repos.memberWorkspaces.get(record.id)?.holder;
      if (after && after.sessionId !== sessionId && this.holds(after))
        throw this.busy(record.member, record.repo, after);
    }
    this.hold(record, sessionId, taskKey);
  }

  private hold(record: MemberWorkspaceRecord, sessionId: string, taskKey: string): void {
    const holder: WorkspaceHolder = {
      sessionId,
      taskKey,
      pid: null,
      scopeId: null,
      cleanupFailed: false,
      since: isoNow(this.ctx),
    };
    this.ctx.repos.memberWorkspaces.hold(record.id, holder);
  }

  /** Whether the holder's process still holds the workspace (proven gone otherwise). */
  private holds(holder: WorkspaceHolder): boolean {
    if (holder.cleanupFailed) return true;
    if (this.starting.has(holder.sessionId) || this.deps.isRunning(holder.sessionId)) return true;
    return holder.pid !== null && this.alive(holder.pid);
  }

  /**
   * The holder's running session when it may be stopped for another task: it idles (no turn,
   * no question pending) on a task that is closed or that the member no longer works on. An
   * idle member with no queued work on its current card also yields to its queue after two minutes.
   */
  private yieldingSession(config: ProjectConfig, holder: WorkspaceHolder, taskKey: string): Session | null {
    if (!this.deps.isRunning(holder.sessionId)) return null;
    const session = this.ctx.repos.sessions.get(holder.sessionId);
    if (!session || session.state !== 'idle') return null;
    const task = this.ctx.repos.tasks.get(holder.taskKey);
    if (task && isOpenTask(task) && isWorkingOnTask(config, task, session.member, session.state)) {
      const idleSince = Date.parse(session.stateSince ?? session.lastActivityAt);
      if (!Number.isFinite(idleSince) || this.ctx.now().getTime() - idleSince < WORKSPACE_YIELD_IDLE_MS)
        return null;
      const items = this.ctx.repos.memberQueue.listOpen(session.projectKey, session.member);
      if (
        items.some(
          (item) =>
            item.taskKey === holder.taskKey ||
            (item.place.type === 'task' && item.place.taskKey === holder.taskKey),
        )
      )
        return null;
      if (
        !items.some(
          (item) => item.state === 'queued' && item.place.type === 'task' && item.place.taskKey === taskKey,
        )
      )
        return null;
    }
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
    case 'workspace_dependencies_pending':
    case 'workspace_dependencies_failed':
      return conflict(code, message, details);
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
