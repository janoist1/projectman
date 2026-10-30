import type { EnsureSessionResult } from '../../contracts';
import type { SessionStartCause } from '@projectman/shared';
import path from 'node:path';
import {
  DEFAULT_AGENT_PROVIDER,
  effectiveRepo,
  isMergeFixer,
  guestOfConversation,
  handoffBlocksStart,
  isTheme,
  memberOf,
  memberStorageHandle,
  outboundNetworkOf,
  repoOf,
  routes,
  autoCompactWindowOf,
  screenshotPlacement,
  usesCodexCli,
} from '@projectman/shared';
import type {
  AgentProvider,
  AiMemberConfig,
  EngineId,
  HandoffSummary,
  ProjectConfig,
  Session,
  Task,
  WorkItemRef,
} from '@projectman/shared';
import {
  BROWSERS_PATH_VARIABLE,
  SESSION_DIR_VARIABLE,
  WORKSPACE_CODEX_CONFIG,
  openingTurnOrigin,
  PROVIDER_NOT_LOGGED_IN,
} from '../../contracts';
import type {
  EngineHost,
  EngineSessionFolders,
  PreviousConversation,
  ScreenshotScope,
  SessionPolicy,
  WorktreeInfo,
} from '../../contracts';
import type { TaskHandoffRow } from '../../db';
import { assertAiEnabled, assertNotOnLeave, assertNotPaused, assertRepoChosen } from '../admission';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import { conflict, DomainError, themeRefused } from '../../kernel';
import {
  allowedToolsFor,
  deniedToolsFor,
  buildSessionPolicy,
  sessionPolicyFor,
  guestSessionDir,
  memberSandboxDir,
  sensitivePaths,
  sessionFolderAccess,
  sessionSandbox,
  usesWorktree,
  withReaderDenials,
  withSessionFolders,
} from './session-policy';
import { aiActor, newId, newUuid, SYSTEM_ACTOR } from '../../kernel';
import type { MergeCardLock } from '../../kernel';
import type { LiveSessions } from './live-sessions';
import type { MemberWorkspaces, WorkspacePlacement } from './workspaces';
import { engineIdOf, engineOption } from './engines';
import type { SessionOrchestratorDeps } from './sessions';
import { contextMember, type SessionContextInput } from './context-input';

/** Between the messages of a first input, and before the first one after a brief. */
export const MESSAGE_SEPARATOR = '\n\n';

/** What introduces the messages that wait for a new conversation, after its brief. */
const WAITING_MESSAGES_HEADER = 'Messages that were waiting for you when this session started:';

/** The first input of a new conversation: its brief, then the messages that wait for it. */
function newConversationInput(brief: string | null, messages: string[]): string | null {
  if (messages.length === 0) return brief;
  const waiting = messages.join(MESSAGE_SEPARATOR);
  return brief ? [brief, WAITING_MESSAGES_HEADER, waiting].join(MESSAGE_SEPARATOR) : waiting;
}

/** The `code` of module errors (e.g. WorktreeError), without depending on their classes. */
export function errorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

export function providerNotLoggedIn(
  provider: AgentProvider,
  details: Record<string, unknown>,
  detail?: string,
) {
  if (provider === 'nanogpt' && details.problem === 'no_key')
    return conflict('nanogpt_key_missing', 'NanoGPT is not ready', { provider });
  if (
    provider === 'nanogpt' &&
    ['cli_missing', 'cli_too_old', 'chatgpt_login'].includes(String(details.problem))
  )
    return conflict('nanogpt_setup_incomplete', 'NanoGPT is not ready', {
      provider,
      problem: details.problem,
      cliVersion: details.cliVersion,
      minCliVersion: details.minCliVersion,
    });
  return conflict(
    PROVIDER_NOT_LOGGED_IN,
    `${provider} is not logged in with a subscription${detail ? `: ${detail}` : ''}`,
    { provider, ...details },
  );
}

/** A restart of a session for a new permission mode: what it drops. */
interface PermissionRestart {
  /** The process had permissions granted "for this session", which the CLI forgets with it. */
  grantsLost: boolean;
}

function workItemLabel(item: WorkItemRef, member: AiMemberConfig): string {
  if (item.type === 'task') return item.taskKey;
  if (item.type === 'meeting') return item.meetingId;
  return member.handle;
}

/**
 * What the launcher needs from the orchestrator that owns it: the parts of the session manager that
 * stay there (the member workspaces, the publishing of a session, the grants, the folder removals)
 * and are shared with the rest of its life.
 */
interface LaunchHost {
  readonly live: LiveSessions;
  readonly mergeCards: MergeCardLock;
  readonly screenshotScopes: Map<string, ScreenshotScope>;
  /** Shared placement-independent input reads, also used by the context preview. */
  readonly contextInput: SessionContextInput;
  readonly workspacesOf: (engineId: EngineId) => MemberWorkspaces | null;
  readonly allWorkspaces: () => MemberWorkspaces[];
  readonly publishSession: (session: Session) => void;
  readonly recomputeMemberState: (projectKey: string, handle: string) => void;
  readonly sessionGrants: (session: Pick<Session, 'id' | 'projectKey'>) => number;
  readonly cardEngineId: (projectKey: string, task: Task) => EngineId;
  readonly transcriptWritten: (session: Session) => Promise<boolean>;
  readonly transcriptSummary: (session: Session) => Promise<HandoffSummary | null>;
  /** The compaction a resumed conversation owes, to type first (`RoundCompaction.firstOnResume`). */
  readonly compactFirst: (
    existing: Session | null,
    resume: boolean,
    provider: AgentProvider | undefined,
  ) => string | undefined;
  readonly assertProviderReady: (
    provider: AgentProvider,
    member: string,
    engineId?: EngineId,
  ) => Promise<void>;
  readonly removeSessionFolderOf: (sessionId: string) => void;
  /** Ends a session whose process never ran as failed, the way the orchestrator ends any session. */
  readonly markStartFailed: (sessionId: string) => void;
  /** The removal of the session's earlier folder that is still running, if any. */
  readonly folderRemoval: (sessionId: string) => Promise<void> | undefined;
}

/** Starts the session's processes: the checks, the placement and the files a start needs, then the process. */
export class SessionLauncher {
  private readonly ctx: DomainContext;
  private readonly deps: SessionOrchestratorDeps;
  private readonly host: LaunchHost;
  private readonly live: LiveSessions;
  private readonly mergeCards: MergeCardLock;
  private readonly screenshotScopes: Map<string, ScreenshotScope>;

  constructor(deps: SessionOrchestratorDeps, host: LaunchHost) {
    this.deps = deps;
    this.host = host;
    this.ctx = deps.ctx;
    this.live = host.live;
    this.mergeCards = host.mergeCards;
    this.screenshotScopes = host.screenshotScopes;
  }

  /** Starts the session's process; a member workspace it reserved is freed again when that fails. */
  async start(
    config: ProjectConfig,
    member: AiMemberConfig,
    workItem: WorkItemRef,
    task: Task | null,
    existing: Session | null,
    messages: string[],
    announce: boolean,
    restart: PermissionRestart | null = null,
    nudge: string | null = null,
    cause: SessionStartCause | null = null,
    pauseRestart = false,
  ): Promise<EnsureSessionResult> {
    // A theme is not worked on: its description is written from the member's general chat.
    if (task && isTheme(task)) throw themeRefused(task.key, 'have a session');
    const sessionId = existing?.id ?? newId('ses');
    try {
      return await this.launch(
        config,
        member,
        workItem,
        task,
        existing,
        messages,
        announce,
        sessionId,
        restart,
        nudge,
        cause,
        pauseRestart,
      );
    } catch (err) {
      for (const workspaces of this.host.allWorkspaces()) workspaces.ended(sessionId);
      // A start that failed leaves no folder behind (PM-268).
      this.host.removeSessionFolderOf(sessionId);
      throw err;
    }
  }

  async launch(
    config: ProjectConfig,
    member: AiMemberConfig,
    workItem: WorkItemRef,
    task: Task | null,
    existing: Session | null,
    messages: string[],
    announce: boolean,
    sessionId: string,
    restart: PermissionRestart | null,
    nudge: string | null,
    cause: SessionStartCause | null,
    pauseRestart: boolean,
  ): Promise<EnsureSessionResult> {
    // A standby copy (PM-143) never works: only one copy of an installation may start AI sessions.
    if (this.deps.standby)
      throw conflict(
        'instance_standby',
        'this instance is a standby copy: AI work runs only in the active one',
      );
    assertAiEnabled(config);
    assertNotPaused(this.ctx.repos.pauses, config.project.key);
    assertNotOnLeave(member);
    // The card is being handed over to the member (PM-342): it starts once the old assignee has handed over.
    const openHandoff = task ? this.ctx.repos.taskHandoffs.open(task.key) : null;
    if (openHandoff && handoffBlocksStart(openHandoff, member.handle))
      throw conflict(
        'task_handoff_open',
        `task ${task!.key} is being handed over from ${openHandoff.from} to ${member.handle}`,
        { taskKey: task!.key, from: openHandoff.from },
      );
    // A role that changes files works in the task's worktree: without a repository to make it in, it
    // would run in the workspace root, so the start is refused until a person chooses one.
    assertRepoChosen(config, member.role, task);
    const projectKey = config.project.key;
    const provider = member.provider ?? DEFAULT_AGENT_PROVIDER;
    // The Operator's or the PM's conversation with someone who is not an owner (PM-475, PM-1080) runs on the
    // team tools alone: no file or shell tools, an empty directory of its own, and every other tool refused.
    const guestOf = guestOfConversation(config, member, workItem);
    // Only the Claude Code adapter can leave a CLI with the team tools alone (`--tools` and deny rules);
    // the others keep their own shell and file tools, so a guest conversation fails closed on them.
    if (guestOf !== undefined && provider !== 'claude')
      throw conflict(
        'provider_unsupported',
        `a conversation with others needs Claude Code; ${provider} cannot be limited to the team tools`,
        { provider },
      );
    // A resume keeps its permission overrides (PM-170); a guest uses team tools alone.
    const acting = contextMember(config, member, workItem, existing);
    const { permissionMode } = acting;
    // The engine the session runs on (PM-311): every path, worktree and folder below is its. A start
    // is refused while it is not connected (admission makes it wait).
    const engineId = this.deps.engines.engineFor(projectKey, member.handle);
    const engine = engineId ? this.deps.engines.get(engineId) : null;
    if (!engineId || !engine)
      throw conflict(
        'engine_offline',
        engineId ? `engine ${engineId} is not connected` : 'there is no engine to start the session on',
        engineId ? { engine: engineId } : {},
      );
    const paths = engine.paths();
    const workspaces = this.host.workspacesOf(engineId);
    // A CLI that is not logged in could only sit at its login screen: refuse before any work.
    await this.host.assertProviderReady(provider, member.handle, engineId);
    // The project's working directory on the engine; null: the engine does not hold the project, so
    // the start waits like one for an engine that is not connected (never on the server's own path).
    const workspaceRoot = engine.workspacePath(projectKey);
    if (!workspaceRoot)
      throw conflict('engine_offline', `engine ${engineId} does not hold project ${projectKey}`, {
        engine: engineId,
      });
    let cwd = workspaceRoot;
    let branch: string | null = null;
    let additionalDirectories: string[] | undefined;
    // The shared git directories a reader's checkouts point to (PM-425): it reads them beside the checkout.
    const readerGitDirs: string[] = [];
    // The repository the task's work happens in: its own, else the project's only one (see
    // `effectiveRepo`). Without one the session runs in the workspace root: a project without
    // repositories, or a role that only reads (the ones that change files were refused above).
    const repoName = effectiveRepo(config, task);
    let placed: WorktreeInfo | null = null;
    let ws: WorkspacePlacement | null = null;
    const mergeFix = isMergeFixer(task?.merge, member.handle);
    if (mergeFix && task && repoName) {
      if (engineId !== this.host.cardEngineId(projectKey, task))
        throw conflict('merge_fix_engine_mismatch', 'merge fix must run on the card engine');
      placed = await this.mergeCards.run(projectKey, task.key, async () => {
        const current = this.deps.tasks.get(projectKey, task.key);
        if (!isMergeFixer(current.merge, member.handle))
          throw conflict('merge_fix_not_allowed', 'the merge fix ended before placement');
        return engine.worktrees.ensureMergeFix({
          project: config,
          repoName,
          taskKey: task.key,
          commit: current.merge!.commit!,
        });
      });
      cwd = placed.path;
      branch = placed.branch;
    } else if (task && repoName && workspaces?.kindFor(config, member, task)) {
      // The member's own durable workspace (PM-138): reserved for this session, on the task's branch
      // or the handed-over commit under review.
      ws = await workspaces.prepare(config, member, task, sessionId);
      cwd = ws.info.path;
      branch = ws.checkout.branch;
      if (ws.binding.kind === 'work' && branch) {
        const github = repoOf(config, repoName)?.github;
        this.deps.tasks.addLink(
          projectKey,
          task.key,
          { kind: 'branch', ref: branch, ...(github ? { repo: github } : {}) },
          SYSTEM_ACTOR,
        );
      }
    } else if (guestOf !== undefined) {
      // Its own empty directory: not the workspace, and its transcript is not the owner's conversation's.
      cwd = guestSessionDir(paths.home ?? path.join(paths.userHome, '.projectman'), projectKey, guestOf);
      await engine.preparePortablePaths([cwd]);
    } else if (task && repoName && usesWorktree(member.role, config)) {
      // Code-changing roles work in the task's own worktree and branch; others in the workspace.
      try {
        placed = await engine.worktrees.ensureForTask({
          project: config,
          repoName,
          taskKey: task.key,
          title: task.title,
        });
        cwd = placed.path;
        branch = placed.branch;
        // The shared git directory is not made writable: a sandboxed agent could plant hooks or
        // configuration there that run when the host uses git in that repository (PM-131).
      } catch (err) {
        throw new DomainError(
          'session_start_failed',
          `could not prepare the worktree: ${(err as Error).message}`,
          { status: 502, details: { stage: 'worktree', reason: errorCode(err) } },
        );
      }
      const github = repoOf(config, repoName)?.github;
      this.deps.tasks.addLink(
        projectKey,
        task.key,
        { kind: 'branch', ref: branch, ...(github ? { repo: github } : {}) },
        SYSTEM_ACTOR,
      );
    }
    if (task && repoName && !ws && workspaces && sessionPolicyFor(member.role, config).readOnlyTools) {
      // A reader without a workspace of its own reads the developer's, while it is on this task.
      const readable = await workspaces.readableWork(config, task.key);
      if (readable) additionalDirectories = [readable];
    } else if (
      task &&
      repoName &&
      !ws &&
      !usesWorktree(member.role, config) &&
      sessionPolicyFor(member.role, config).readOnlyTools
    ) {
      try {
        const found = await engine.worktrees.find({
          project: config,
          repoName,
          taskKey: task.key,
        });
        if (found) {
          additionalDirectories = [found.path];
          if (found.gitDir) readerGitDirs.push(found.gitDir);
        }
      } catch (err) {
        this.ctx.logger.warn({ err, taskKey: task.key }, 'could not find the task worktree for review');
      }
    }
    // The conversation of an earlier start belongs to the directory it ran in. When the task's
    // worktree is somewhere else (the task had no repository then, or another one) it cannot carry on
    // there: the session starts a new conversation in the worktree instead of working elsewhere.
    // So does a conversation of an older generation of the member's workspace (made again or moved).
    // A conversation lives on the engine it ran on (PM-311): it cannot be resumed on another one.
    const engineChanged = Boolean(existing && engineIdOf(existing) !== engineId);
    const relocated = Boolean(
      existing &&
      (engineChanged ||
        Boolean(existing.branch?.startsWith('merge-fix/')) !== mergeFix ||
        (guestOf !== undefined && path.resolve(existing.cwd) !== path.resolve(cwd)) ||
        ((placed || ws) && (path.resolve(existing.cwd) !== path.resolve(cwd) || ws?.newGeneration))),
    );
    if (existing && !relocated && !ws && guestOf === undefined) {
      // Claude Code keeps conversations per working directory: resume where it started.
      cwd = existing.cwd;
      branch = existing.branch ?? branch;
    }

    const prepared = await this.host.contextInput.prepare(config, member, workItem, task);
    const { attachmentRules, attachmentDirs } = prepared;
    // Resume only a conversation that exists (the runner reported its transcript), that belongs to
    // the member's current provider and that ran where the session runs now. The reported path is not
    // proof (PM-340): the CLI writes the file after its first message, and cannot resume what it never
    // wrote. A session that never got its first round starts a new conversation.
    const resumable =
      !relocated &&
      Boolean(existing?.transcriptPath && (existing.provider ?? DEFAULT_AGENT_PROVIDER) === provider);
    const conversationLost = resumable && !(await this.host.transcriptWritten(existing!));
    const resume = resumable && !conversationLost;
    // A new conversation that replaces one that could not go on tells the member so (PM-342), with a
    // machine-made summary of the old transcript when it can be read.
    const previousConversation =
      !existing || resume
        ? null
        : await this.previousConversation(existing, provider, conversationLost, relocated);
    // The card handed over to this member, until a session of theirs takes it over (PM-342); a new
    // conversation also gets the card's latest handoff note, whoever wrote it.
    const { takenHandoff, handoff } = this.host.contextInput.handoffFor(task, member);
    let lastNoteId: string | undefined;
    if (previousConversation && task) {
      const note = this.ctx.repos.taskHandoffs.latestNote(task.key);
      if (note?.note && note.endedAt) {
        previousConversation.lastNote = { from: note.from, endedAt: note.endedAt, text: note.note };
        lastNoteId = note.id;
      }
    }
    // Who else works on the card and what was asked on it (PM-249): a new conversation gets the latest
    // questions, a resumed one those since it last ran.
    const standing = this.host.contextInput.standingFor(config, member, task, existing, resume);
    // What a returning reviewer reviewed last (PM-213), named in the message that wakes it.
    const lastReviewedCommit = existing ? this.ctx.repos.sessions.reviewedCommit(existing.id) : null;
    const { userHome } = paths;
    const appHome = paths.home ?? undefined;
    const folders = engine.sessionFolders;
    // A Claude session of the legacy profile gets its own Claude Code temporary root (PM-353) when the
    // engine can make one; only then are the roots all Claude Code processes share closed to it (the
    // CLI itself still uses them otherwise). Every other provider closes them: its CLI does not.
    const claudeTmpRoots = paths.claudeTmpRoots;
    const claudeOwnTmp = provider === 'claude' && !!folders?.tmpRoot;
    const policy = withReaderDenials(
      buildSessionPolicy({
        config,
        role: member.role,
        member: member.handle,
        task,
        permissionMode,
        deniedPaths: [
          ...sensitivePaths({ userHome, appHome }),
          ...(provider !== 'claude' || claudeOwnTmp ? claudeTmpRoots : []),
        ],
        outboundNetwork: outboundNetworkOf(member),
        provider,
        placement: ws
          ? ws.placement
          : placed
            ? {
                kind: 'task_worktree',
                ...(mergeFix ? { mergeFix: { branch: branch! } } : {}),
                path: cwd,
                ...(placed.gitDir ? { gitDir: placed.gitDir } : {}),
                ...(placed.worktreeGitDir ? { worktreeGitDir: placed.worktreeGitDir } : {}),
              }
            : ({ kind: 'read_only', path: cwd } satisfies SessionPolicy['placement']),
        readableRoots: additionalDirectories,
        ...(attachmentDirs.length > 0 ? { readOnlyPaths: attachmentDirs } : {}),
        ...(guestOf !== undefined ? { teamToolsOnly: true } : {}),
      }),
      userHome,
    );
    // A developer's npm cache and development data live in its own directory (PM-193).
    const memberDir =
      policy.access === 'task_worktree' && appHome
        ? await this.prepareMemberSandboxDir(engine, appHome, projectKey, memberStorageHandle(member))
        : undefined;
    const excludesFile = paths.gitExcludesFile;
    // A session of the legacy profile gets its own folder (`sessionFolderAccess`, PM-268, PM-339,
    // PM-522): Claude Code's sandbox and a writing Codex or NanoGPT sandbox write it (with the browsers);
    // a read-only Codex or NanoGPT sandbox only reads what the server puts there, and Gemini's file
    // tools write it under the hook's gate. The mode changes only with a restart. A Codex CLI sandbox
    // also needs the short TMPDIR root: without it the shared `/tmp` stays open, so no folder either.
    const folderAccess = sessionFolderAccess({
      provider,
      sandbox: policy.permissions.sandbox,
      tmpRoot: !!folders?.tmpRoot,
    });
    const codexWrites = usesCodexCli(provider) && folderAccess === 'write';
    // The sandbox itself writes the folder (and so gets the browsers and the screenshot scope).
    const sandboxWritesFolder = provider === 'claude' || codexWrites;
    // A new path at every start: what an earlier run left running cannot use or pre-empt it.
    const sessionDir = folderAccess && folders ? folders.allocate(sessionId) : undefined;
    const tmpDir = (codexWrites || claudeOwnTmp) && sessionDir ? folders?.allocateTmp(sessionId) : undefined;
    const tmpBase = folders?.tmpRoot ? path.dirname(folders.tmpRoot) : undefined;
    const browsersDir = sandboxWritesFolder ? (paths.browsersDir ?? undefined) : undefined;
    const sandbox = sessionSandbox(policy, {
      userHome,
      ...(appHome ? { appHome } : {}),
      ...(sessionDir ? { sessionDir } : {}),
      ...(tmpDir ? { tmpDir, sharedTmpRoots: [...claudeTmpRoots, ...(tmpBase ? [tmpBase] : [])] } : {}),
      ...(browsersDir ? { browsersDir } : {}),
      ...(paths.heavyLockDir ? { heavyLockDir: paths.heavyLockDir } : {}),
      ...(repoName ? { defaultBranch: repoOf(config, repoName)?.defaultBranch } : {}),
      ...(memberDir ? { memberDir } : {}),
      ...(excludesFile ? { excludesFile } : {}),
      ...(readerGitDirs.length > 0 ? { gitDirs: readerGitDirs } : {}),
      github: Boolean(repoOf(config, effectiveRepo(config, task))?.github),
      // A reader changes no checkout of the project or the installation (PM-188).
      readerDenyWrite: [
        workspaceRoot,
        ...[paths.home, paths.worktreesRoot, paths.workspacesRoot, paths.installDir].filter(
          (dir): dir is string => !!dir,
        ),
      ],
    });
    // The shared roots are closed in the policy already: a sandbox that dropped the session's own temporary
    // directory would leave the CLI on a root it can no longer reach. Only a programming error; no start.
    if (claudeOwnTmp && sandbox && sandbox.portable?.tmpDir !== tmpDir)
      throw new Error(`The sandbox of session ${sessionId} dropped its Claude Code temporary directory`);
    // The folder the sandbox kept and its root go into the policy: the adapter renders the file-tool
    // rules from it, and drops the legacy allow list beside a policy (PM-333).
    const sessionFolder = sandbox?.env?.[SESSION_DIR_VARIABLE];
    // A team-tools-only guest conversation gets no session folder rules: it reads no file at all.
    const startPolicy = withSessionFolders(
      sandbox?.portable?.readBoundary
        ? { ...policy, filesystem: { ...policy.filesystem, readBoundary: sandbox.portable.readBoundary } }
        : policy,
      sessionFolder && folders && guestOf === undefined
        ? { own: sessionFolder, root: folders.root }
        : undefined,
    );
    const input = await this.host.contextInput.build(
      config,
      member,
      workItem,
      task,
      existing,
      cause,
      prepared,
      standing,
      handoff,
    );
    const pack = this.deps.contextBuilder.build({
      ...input,
      sessionPolicy: startPolicy,
      ...(sandbox ? { sandbox } : {}),
      ...(lastReviewedCommit ? { lastReviewedCommit } : {}),
      ...(previousConversation && task ? { previousConversation } : {}),
    });

    // Configuration may change while login, worktree and memory preparation await I/O. So may the
    // task's repository: no live session holds it in place before the session is recorded below.
    const latestConfig = await this.deps.projects.config(projectKey);
    assertAiEnabled(latestConfig);
    assertNotPaused(this.ctx.repos.pauses, projectKey);
    assertNotOnLeave(memberOf(latestConfig, member.handle));
    if (task) {
      const latestTask = this.deps.tasks.get(projectKey, task.key);
      if (
        mergeFix &&
        (!isMergeFixer(latestTask.merge, member.handle) ||
          latestTask.merge?.fix?.branch !== branch ||
          latestTask.merge?.fix?.startedAt !== task.merge?.fix?.startedAt)
      )
        throw conflict('merge_fix_not_allowed', 'the merge-fix authorization changed while starting', {
          reason: 'not_conflict',
        });
      assertRepoChosen(latestConfig, member.role, latestTask);
      if ((placed || ws) && effectiveRepo(latestConfig, latestTask) !== repoName) {
        throw conflict(
          'session_start_failed',
          `the repository of task ${task.key} changed while the session was starting: start it again`,
          { taskKey: task.key },
        );
      }
    }
    try {
      await this.deps.runner.assertWorkspaceConfig?.({ provider, cwd, ...engineOption(engineId) });
    } catch (err) {
      if (errorCode(err) !== WORKSPACE_CODEX_CONFIG) throw err;
      const failure = err as Error & { details?: Record<string, unknown> };
      throw conflict(WORKSPACE_CODEX_CONFIG, failure.message, { ...failure.details, provider });
    }
    // Made now, before the process: Claude Code may not handle a write path that does not exist. A
    // failed start removes it (`start`); a restart's old folder was removed when its process ended.
    const sessionTmpDir = sandbox?.portable?.tmpDir;
    if (folders && (sessionFolder || sessionTmpDir))
      await this.prepareSessionFolder(folders, sessionId, sessionFolder, sessionTmpDir);
    // The temporary directory is not made by `preparePortablePaths`: a recursive mkdir takes a path
    // that exists (a link). `make` makes it new, with the folder.
    await this.preparePortablePaths(engine, sandbox?.portable?.allowWrite);
    // A session in a checkout of the card (worktree or review copy) with a folder of its own, on Claude or a
    // Codex CLI sandbox (Gemini takes none, PM-522). A reading sandbox does not write the folder: the run
    // then writes only the folder, never the checkout (PM-1202).
    if (
      sessionFolder &&
      sandbox &&
      screenshotPlacement(policy.access) &&
      (provider === 'claude' || usesCodexCli(provider))
    ) {
      const browsers = sandbox.env?.[BROWSERS_PATH_VARIABLE] ?? paths.browsersDir ?? undefined;
      this.screenshotScopes.set(sessionId, {
        cwd,
        sessionDir: sessionFolder,
        ...(browsers ? { browsersDir: browsers } : {}),
        sandbox: {
          allowWrite: sandboxWritesFolder ? [...sandbox.allowWrite] : [sessionFolder],
          denyWrite: sandboxWritesFolder
            ? [...(sandbox.denyWrite ?? [])]
            : [...new Set([...(sandbox.denyWrite ?? []), cwd])],
          denyRead: [...(sandbox.denyRead ?? [])],
          // The run reads the checkout it runs in, whatever the home's closure says; the browsers too, which
          // a reading session's own sandbox may not have been given.
          allowRead: [...new Set([cwd, ...(sandbox.allowRead ?? []), ...(browsers ? [browsers] : [])])],
        },
      });
    }
    const at = isoNow(this.ctx);
    // A conversation whose round ended while its session did not run is compacted before anything
    // else is typed (PM-213), if it is big: the wake-up messages and the continue message follow it.
    const compactFirst = this.host.compactFirst(existing, resume, provider);
    let session: Session;
    if (existing) {
      session = this.ctx.repos.sessions.update(existing.id, {
        state: 'starting',
        activity: null,
        stateSince: at,
        cwd,
        branch,
        engineId,
        lastActivityAt: at,
        endedAt: null,
        lastStop: null,
        ...(relocated || conversationLost ? { claudeSessionId: newUuid(), transcriptPath: null } : {}),
        // This start takes the session's current mode; the header says when it dropped grants.
        permissionRestartPending: false,
        permissionGrantsLost: restart?.grantsLost ?? false,
        // A session from before the measurement (PM-178) is counted from this resume on.
        ...(existing.usage ? {} : { usageSince: at }),
      })!;
    } else {
      session = {
        id: sessionId,
        projectKey,
        member: member.handle,
        workItem,
        claudeSessionId: newUuid(),
        provider,
        cwd,
        branch,
        engineId,
        transcriptPath: null,
        state: 'starting',
        activity: null,
        stateSince: at,
        startedAt: at,
        lastActivityAt: at,
        endedAt: null,
      };
      this.ctx.repos.sessions.insert(session);
      session = this.ctx.repos.sessions.update(session.id, { usageSince: at })!;
    }
    const token = this.live.issueToken(session);
    this.live.guides.set(session.id, pack.guide);
    this.live.providers.set(session.id, provider);
    if (resume) this.live.resuming.add(session.id);
    // Before the process starts: Codex reports its first input as it starts.
    const firstInput = messages.length > 0 ? this.live.awaitFirstInput(session.id) : Promise.resolve(true);
    // A pause's nudge (PM-219) goes first on a resumed conversation: before the messages, or in place of
    // the continue message. A new conversation has nothing to be nudged about.
    const resumedInput = resume
      ? messages.length > 0
        ? [...(nudge ? [nudge] : []), ...messages].join(MESSAGE_SEPARATOR)
        : (nudge ?? (restart ? null : pack.continueMessage))
      : null;
    // A resumed conversation is told first about the card now (PM-249): who else works on it, and the
    // questions asked or answered since it last ran.
    const initialMessage = resume
      ? announce && pack.standing
        ? [pack.standing, resumedInput].filter((part) => part?.trim()).join(MESSAGE_SEPARATOR)
        : resumedInput
      : newConversationInput(pack.initialMessage, messages);
    if (initialMessage?.trim()) this.live.awaitingFirstTurn.add(session.id);

    try {
      if (mergeFix && placed)
        this.live.mergeFixes.set(session.id, { branch: placed.branch, cwd: placed.path });
      else this.live.mergeFixes.delete(session.id);
      const info = await this.deps.runner.start({
        sessionId: session.id,
        claudeSessionId: session.claudeSessionId,
        resume,
        cwd,
        engineId,
        projectKey,
        member: member.handle,
        displayName: `${member.displayName} · ${workItemLabel(workItem, member)}`,
        model: member.model,
        effort: member.effort,
        // The member's value, else the project's, else the default (PM-212); on a resume too.
        autoCompactWindowTokens: autoCompactWindowOf(config.team.limits, member),
        // `--permission-mode` (Claude Code) and the `-c` settings (Codex) take it on a resume too.
        permissionMode,
        appendSystemPrompt: pack.appendSystemPrompt,
        // The cheap subagent (PM-179), on a resume too: the CLI takes its subagents per process.
        ...(pack.subagents.length > 0 ? { subagents: pack.subagents } : {}),
        // A resumed conversation has its brief already; it needs to know why it was woken: by the
        // messages that did it, else by the continue message. One that restarts into a new mode
        // (PM-170) was idle: it waits at its prompt, as it did, and its waiting messages are typed in
        // once it runs. A new conversation gets the messages after its brief, in full (PM-180):
        // typed in later they would wait for the end of its first turn.
        initialMessage,
        ...(compactFirst ? { compactFirst } : {}),
        firstUserOrigin: openingTurnOrigin(workItem),
        mcpUrl: `${this.deps.publicBaseUrl}${routes.mcp(token)}`,
        policy: startPolicy,
        allowedTools: [
          ...allowedToolsFor(member.role, config, { teamToolsOnly: guestOf !== undefined }),
          ...attachmentRules.allow,
        ],
        deniedTools: [...deniedToolsFor(config, task), ...attachmentRules.deny],
        additionalDirectories,
        // The CLI's own sandbox (decision 28): a developer's in its worktree, a reader's that writes
        // only the temp directory (PM-167).
        ...(sandbox ? { sandbox } : {}),
        provider,
      });
      // A new conversation owes and measures nothing yet. A resumed one that was asked to compact
      // keeps owing it until the runner reports it done or given up; one that owed it but is small
      // owes nothing any more.
      if (!resume) {
        this.ctx.repos.sessions.setCompactPending(session.id, false);
        this.ctx.repos.sessions.setContextTokens(session.id, null);
        this.ctx.repos.sessions.setReviewedCommit(session.id, null);
      } else if (!compactFirst) {
        this.ctx.repos.sessions.setCompactPending(session.id, false);
      }
      // The commit a reviewer works on this round: the next wake-up names it as the last reviewed.
      if (task?.reviewPin && task.assignee !== member.handle)
        this.ctx.repos.sessions.setReviewedCommit(session.id, task.reviewPin.commit);
      this.live.modes.set(session.id, permissionMode);
      this.live.grants.set(session.id, this.host.sessionGrants(session));
      workspaces?.started(session.id, info.pid, info.scopeId);
      const current = this.ctx.repos.sessions.get(session.id);
      if (current?.state === 'starting' && info.state !== 'starting') {
        this.ctx.repos.sessions.update(session.id, { state: info.state, stateSince: isoNow(this.ctx) });
      }
    } catch (err) {
      // The start is over before a process ran: the session ends the way any does (what is held for it goes, its
      // folder is removed, the timeline and the listeners are told).
      this.host.markStartFailed(session.id);
      if (errorCode(err) === PROVIDER_NOT_LOGGED_IN) {
        const status = (err as { status?: { problem?: string; cliVersion?: string; minCliVersion?: string } })
          .status;
        throw providerNotLoggedIn(provider, { sessionId: session.id, ...status }, (err as Error).message);
      }
      if (
        [
          'nanogpt_key_missing',
          'nanogpt_setup_incomplete',
          'codex_setup_incomplete',
          'provider_unsupported',
        ].includes(errorCode(err) ?? '')
      ) {
        const failure = err as Error & {
          code:
            | 'nanogpt_key_missing'
            | 'nanogpt_setup_incomplete'
            | 'codex_setup_incomplete'
            | 'provider_unsupported';
          details?: Record<string, unknown>;
        };
        throw conflict(failure.code, failure.message, failure.details);
      }
      if (errorCode(err) === WORKSPACE_CODEX_CONFIG) {
        const failure = err as Error & { details?: Record<string, unknown> };
        throw conflict(WORKSPACE_CODEX_CONFIG, failure.message, {
          ...failure.details,
          sessionId: session.id,
          provider,
        });
      }
      throw new DomainError(
        'session_start_failed',
        `could not start the session: ${(err as Error).message}`,
        {
          status: 502,
          details: { sessionId: session.id },
        },
      );
    }

    this.deps.timeline.append({
      projectKey,
      taskKey: task?.key ?? null,
      sessionId: session.id,
      actor: aiActor(member.handle),
      type: 'session_started',
      data: { member: member.handle, resumed: resume, ...(cause ? { cause } : {}) },
    });
    this.ctx.repos.sessions.update(session.id, { startCause: cause });
    if (previousConversation && task) {
      this.deps.timeline.append({
        projectKey,
        taskKey: task.key,
        sessionId: session.id,
        actor: SYSTEM_ACTOR,
        type: 'session_conversation_restarted',
        data: {
          member: member.handle,
          reason: previousConversation.reason,
          ...(previousConversation.fromProvider
            ? { fromProvider: previousConversation.fromProvider, toProvider: provider }
            : {}),
          summary: previousConversation.summary !== null,
          ...(previousConversation.lastNote && lastNoteId ? { lastHandoffId: lastNoteId } : {}),
        },
      });
    }
    if (takenHandoff && task) this.recordTakeover(takenHandoff, session, task);
    const fresh = this.ctx.repos.sessions.get(session.id)!;
    this.host.publishSession(fresh);
    this.host.recomputeMemberState(projectKey, member.handle);
    void this.ctx.events.emit('session_started', fresh);
    // The card's other workers are told who joined (PM-249); a restart is not a joining.
    if (announce && !pauseRestart && workItem.type === 'task')
      void this.ctx.events.emit('task_session_joined', { session: fresh, resumed: resume, cause });
    return {
      session: fresh,
      created: !existing,
      resumed: resume,
      started: true,
      messagesSent: messages.length,
      firstInput,
    };
  }

  /** The member's session took the handed-over card over (PM-342): the handoff is marked and the timeline says so. */
  private recordTakeover(row: TaskHandoffRow, session: Session, task: Task): void {
    this.ctx.repos.taskHandoffs.save({
      ...row,
      takenOverAt: isoNow(this.ctx),
      takenOverSessionId: session.id,
    });
    this.deps.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      sessionId: session.id,
      actor: aiActor(session.member),
      type: 'task_handoff',
      data: {
        phase: 'taken_over',
        handoffId: row.id,
        from: row.from,
        to: row.to,
        fromProvider: row.fromProvider,
        toProvider: row.toProvider,
        sessionId: session.id,
      },
    });
  }

  /**
   * Why the new conversation of `existing` is not its old one (PM-342): the provider changed, the old
   * conversation is lost, or it ran elsewhere; with a summary of the old transcript. Null when a
   * conversation was never written (nothing was lost).
   */
  private async previousConversation(
    existing: Session,
    provider: AgentProvider,
    conversationLost: boolean,
    relocated: boolean,
  ): Promise<PreviousConversation | null> {
    const from = existing.provider ?? DEFAULT_AGENT_PROVIDER;
    const summarize = () => this.host.transcriptSummary(existing);
    if (existing.transcriptPath && from !== provider)
      return { reason: 'provider_changed', fromProvider: from, summary: await summarize(), lastNote: null };
    if (conversationLost) return { reason: 'lost', fromProvider: null, summary: null, lastNote: null };
    if (relocated && existing.transcriptPath)
      return { reason: 'relocated', fromProvider: null, summary: await summarize(), lastNote: null };
    return null;
  }

  /**
   * The member's sandbox directory with its npm cache and development data, made if missing on the
   * session's engine (PM-193); the git settings in it are written at every start (PM-216).
   */
  private async prepareMemberSandboxDir(
    engine: EngineHost,
    appHome: string,
    projectKey: string,
    handle: string,
  ): Promise<string> {
    const dir = memberSandboxDir(appHome, projectKey, handle);
    try {
      await engine.prepareMemberSandboxDir(dir);
    } catch (err) {
      throw new DomainError(
        'session_start_failed',
        `could not prepare the member's sandbox directory: ${(err as Error).message}`,
        { status: 502, details: { stage: 'member_sandbox_dir', reason: errorCode(err) } },
      );
    }
    return dir;
  }

  /**
   * The session's own folder (PM-268) and, for Codex, its temporary directory (PM-339), made before
   * its process starts. A path that exists already stops the start.
   */
  private async prepareSessionFolder(
    folders: EngineSessionFolders,
    sessionId: string,
    dir: string | undefined,
    tmpDir?: string,
  ): Promise<void> {
    try {
      // The folder an earlier run of this session had goes first (see `removeSessionFolderOf`).
      await this.host.folderRemoval(sessionId);
      await folders.make(sessionId, dir, tmpDir);
    } catch (err) {
      throw new DomainError(
        'session_start_failed',
        `could not prepare the session folder: ${(err as Error).message}`,
        { status: 502, details: { stage: 'session_folder', reason: errorCode(err) } },
      );
    }
  }

  /**
   * The writable paths a CLI with a sandbox of its own takes from ours (`AgentSandbox.portable`,
   * PM-346), made before its process starts so it gets an existing path. A failure is logged: the
   * start goes on.
   */
  private async preparePortablePaths(
    engine: EngineHost,
    paths: readonly string[] | undefined,
  ): Promise<void> {
    if (paths?.length) await engine.preparePortablePaths(paths);
  }
}
