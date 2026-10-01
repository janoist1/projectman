import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@projectman/shared';
import type { AttachmentStorage } from '../src/contracts';
import {
  allowedToolsFor,
  DomainError,
  LOCAL_ONLY_DENIED_TOOLS,
  SANDBOX_DENIED_ENV_VARS,
  SANDBOX_GIT_CONFIG,
  SANDBOX_GIT_CONFIG_FILE,
  SANDBOX_PTY_ENV,
  sensitivePaths,
} from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { testConfig } from './helpers/test-template';

describe('session orchestrator', () => {
  let h: DomainHarness;
  let events: ServerEvent[];
  beforeEach(async () => {
    h = await createDomainHarness();
    events = [];
    h.domain.bus.subscribe((e) => events.push(e));
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  });
  afterEach(() => h.cleanup());

  const task = { type: 'task' as const, taskKey: 'AR-1' };

  it('reuses a running session, resumes an exited one in the same directory', async () => {
    const first = await h.domain.sessions.ensureSession('AR', 'cr', task);
    expect(first).toMatchObject({ created: true, resumed: false, started: true });
    const again = await h.domain.sessions.ensureSession('AR', 'cr', task);
    expect(again).toMatchObject({ created: false, started: false });
    expect(again.session.id).toBe(first.session.id);
    expect(h.runner.started).toHaveLength(1);

    const token = h.runner.lastStarted().mcpUrl.split('/').pop()!;
    h.runner.emit({ type: 'transcript_path', sessionId: first.session.id, path: '/tmp/transcript.jsonl' });
    h.runner.emit({ type: 'exit', sessionId: first.session.id, exitCode: 0, signal: null });
    expect(h.domain.sessions.get('AR', first.session.id)).toMatchObject({
      state: 'exited',
      transcriptPath: '/tmp/transcript.jsonl',
    });
    expect(h.domain.sessions.resolveToken(token)).toBeNull();

    const resumed = await h.domain.sessions.ensureSession('AR', 'cr', task);
    expect(resumed).toMatchObject({ created: false, resumed: true, started: true });
    expect(resumed.session.id).toBe(first.session.id);
    const spec = h.runner.lastStarted();
    expect(h.contextBuilder.inputs.at(-1)?.sessionPolicy).toBe(spec.policy);
    expect(spec.policy).toMatchObject({ access: 'read_only', enforcement: 'legacy' });
    // Nothing caused the resume but the start itself: the session is told to carry on.
    expect(spec).toMatchObject({
      resume: true,
      claudeSessionId: first.session.claudeSessionId,
      cwd: first.session.cwd,
      initialMessage: 'Continue AR-1: Login page',
    });
    expect(spec.mcpUrl.split('/').pop()).not.toBe(token);
    const timeline = h.domain.timeline
      .list('AR', { taskKey: 'AR-1' })
      .map((e) => [e.type, e.data.resumed ?? null]);
    expect(timeline).toContainEqual(['session_started', true]);
    expect(timeline).toContainEqual(['session_ended', null]);
  });

  it('reads a reloaded chat as its provider wrote it, relative to the session directory', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    expect(session.provider).toBe('claude');
    expect(h.runner.lastStarted()).toMatchObject({ provider: 'claude', firstUserOrigin: 'brief' });
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/tmp/fictional.jsonl' });
    h.runnerModule.transcripts.set('/tmp/fictional.jsonl', []);
    await h.domain.sessions.detail('AR', session.id);
    const general = (await h.domain.sessions.ensureSession('AR', 'cr', { type: 'general' })).session;
    expect(h.runner.lastStarted()).toMatchObject({ firstUserOrigin: 'human' });
    h.runner.emit({ type: 'transcript_path', sessionId: general.id, path: '/tmp/general.jsonl' });
    h.runnerModule.transcripts.set('/tmp/general.jsonl', []);
    await h.domain.sessions.detail('AR', general.id);
    expect(h.runnerModule.transcriptReads).toEqual([
      {
        path: '/tmp/fictional.jsonl',
        opts: { provider: 'claude', self: 'cr', cwd: session.cwd, firstUserOrigin: 'brief' },
      },
      {
        path: '/tmp/general.jsonl',
        opts: { provider: 'claude', self: 'cr', cwd: general.cwd, firstUserOrigin: 'human' },
      },
    ]);
  });

  it('starts over with the brief when the first start never produced a conversation', async () => {
    h.runner.failNextStart = new Error('spawn failed');
    const err = await h.domain.sessions.ensureSession('AR', 'cr', task).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('session_start_failed');
    const failed = h.domain.sessions.list('AR', { member: 'cr' })[0]!;
    expect(failed.state).toBe('failed');

    const retry = await h.domain.sessions.ensureSession('AR', 'cr', task);
    expect(retry.session.id).toBe(failed.id);
    expect(h.runner.lastStarted()).toMatchObject({
      resume: false,
      initialMessage: 'Brief for AR-1: Login page',
    });
  });

  it('mirrors runner events into sessions, member state, chat and terminal events', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    h.runner.setState(session.id, 'working', 'Bash: npm test');
    expect(h.domain.sessions.get('AR', session.id)).toMatchObject({
      state: 'working',
      activity: 'Bash: npm test',
    });
    let roster = await h.domain.members.roster('AR');
    expect(roster.find((m) => m.handle === 'cr')).toMatchObject({
      status: 'working',
      activity: 'Bash: npm test',
      currentTaskKeys: ['AR-1'],
    });

    h.runner.setState(session.id, 'waiting_permission', 'Bash: rm -rf dist');
    roster = await h.domain.members.roster('AR');
    expect(roster.find((m) => m.handle === 'cr')?.status).toBe('waiting_for_human');

    h.runner.emit({
      type: 'chat',
      sessionId: session.id,
      items: [{ id: 'c1', ts: '2026-09-29T10:00:00.000Z', kind: 'assistant_text', text: 'Done' }],
    });
    h.runner.emit({ type: 'terminal_data', sessionId: session.id, data: '\u001b[32mok' });
    h.runner.setState(session.id, 'idle');

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'chat_appended', projectKey: 'AR', sessionId: session.id }),
    );
    expect(events).toContainEqual({ type: 'terminal_data', sessionId: session.id, data: '\u001b[32mok' });
    expect(events).toContainEqual({
      type: 'member_state',
      projectKey: 'AR',
      handle: 'cr',
      status: 'working',
      activity: 'Bash: npm test',
    });
    expect(events.filter((e) => e.type === 'session_upserted').length).toBeGreaterThanOrEqual(4);
    expect(h.repos.memberState.get('AR', 'cr')?.status).toBe('idle');
  });

  it('delivers human messages into the session and records them as team messages', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    const message = await h.domain.messaging.sendToSession(
      'AR',
      session.id,
      'Please check the tests',
      'owner',
    );
    await new Promise((r) => setImmediate(r));
    expect(h.runner.messages).toEqual([{ sessionId: session.id, text: 'Please check the tests' }]);
    expect(message).toMatchObject({ from: 'owner', to: ['cr'], taskKey: 'AR-1' });
    expect(h.repos.messages.get(message.id)?.deliveredAt).not.toBeNull();

    // A stopped session is resumed for the message.
    await h.domain.sessions.stop('AR', session.id);
    expect(h.domain.sessions.get('AR', session.id).state).toBe('exited');
    await h.domain.messaging.sendToSession('AR', session.id, 'Are you there?', 'owner');
    expect(h.runner.started).toHaveLength(2);
  });

  it('stops the sessions of a retired member and hands its tasks over', async () => {
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    expect(started.task.assignee).toBe('dev-1');
    await h.domain.members.retire(
      'AR',
      'dev-1',
      { handoverTo: 'dev-2' },
      { actor: OWNER_ACTOR, author: OWNER },
    );
    expect(h.runner.isRunning(started.session!.id)).toBe(false);
    expect(h.domain.tasks.get('AR', 'AR-1').assignee).toBe('dev-2');
    const config = await h.domain.projects.config('AR');
    expect(config.team.members.map((m) => m.handle)).not.toContain('dev-1');
    expect(config.pipeline.stages.find((s) => s.id === 'development')?.owners).toEqual(['dev-2']);
    const roster = await h.domain.members.roster('AR');
    expect(roster.map((m) => m.handle)).not.toContain('dev-1');
    expect(h.repos.memberState.get('AR', 'dev-1')?.status).toBe('retired');
  });

  it.each([
    [{ handoverTo: 'dev-2' }, { assignee: 'dev-2', previous: 'dev-1', reason: 'handover', from: 'dev-1' }],
    [{}, { assignee: null, previous: 'dev-1', reason: 'member_removed' }],
  ])('records the hand-over of a retired member’s task once (%j)', async (opts, assigned) => {
    await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    const before = h.domain.timeline.list('AR', { taskKey: 'AR-1' }).length;
    events.length = 0;
    await h.domain.members.retire('AR', 'dev-1', opts, { actor: OWNER_ACTOR, author: OWNER });
    const recorded = h.domain.timeline.list('AR', { taskKey: 'AR-1' }).slice(before);
    expect(recorded.filter((e) => e.type === 'task_assigned').map((e) => e.data)).toEqual([assigned]);
    const pushed = events.filter((e) => e.type === 'task_upserted' && e.task.key === 'AR-1');
    expect(pushed.map((e) => e.type === 'task_upserted' && e.task.assignee)).toEqual([assigned.assignee]);
  });

  it('runs reviewers in the workspace with read-only tools, developers in the task worktree', async () => {
    const withRepo = await h.domain.tasks.create('AR', { title: 'With repo', repo: 'web' }, OWNER_ACTOR);
    const review = await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: withRepo.key });
    const files = await h.attachmentRules(withRepo.key);
    expect(review.session).toMatchObject({ cwd: h.workspace, branch: null });
    expect(h.runner.lastStarted().allowedTools).toEqual([
      ...allowedToolsFor('code_review', testConfig()),
      ...files.allow,
    ]);
    expect(h.runner.lastStarted().additionalDirectories).toBeUndefined();
    expect(h.runner.lastStarted().policy).toMatchObject({
      version: 1,
      enforcement: 'legacy',
      access: 'read_only',
      tools: { team: { all: true, names: [] } },
      filesystem: { readableRoots: [h.workspace], writableRoots: [] },
    });
    expect(h.worktrees.calls).toEqual([]);

    const dev = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: withRepo.key });
    expect(dev.session.branch).toBe('task/AR-2');
    expect(dev.session.cwd).not.toBe(h.workspace);
    expect(h.runner.lastStarted().allowedTools).toEqual([
      ...allowedToolsFor('developer', testConfig()),
      ...files.allow,
    ]);
    // No writable git directory: hooks or configuration planted there would run on the host (PM-131).
    expect(h.runner.lastStarted().writableRoots).toBeUndefined();
    expect(h.runner.lastStarted().policy).toMatchObject({
      access: 'task_worktree',
      // This fixture explicitly retains the stricter historical default permission mode.
      permissions: { claude: 'default', sandbox: 'read-only' },
      filesystem: { readableRoots: [dev.session.cwd], writableRoots: [] },
    });
    // Work in its own worktree runs in the OS sandbox, so its shell commands do not ask; the shell
    // does not read the credentials and the live data either (PM-167). Its paths: see below (PM-153).
    const deniedPaths = h.runner.lastStarted().policy!.filesystem.deniedPaths!;
    expect(deniedPaths).toContainEqual(expect.stringMatching(/\/\.ssh$/));
    expect(h.runner.lastStarted().sandbox).toMatchObject({
      denyRead: expect.arrayContaining(deniedPaths),
      allowedDomains: ['registry.npmjs.org'],
      allowLocalBinding: true,
    });
    expect(h.runner.lastStarted().deniedTools).toEqual(files.deny);
    expect(h.domain.tasks.get('AR', withRepo.key).links).toContainEqual({
      kind: 'branch',
      ref: 'task/AR-2',
      repo: 'acme/web',
    });
  });

  it('grants reviewers the existing developer worktree and propagates local-only deny rules', async () => {
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      delete draft.project.repos[0]!.github;
      return 'Use a local-only repository';
    });
    const withRepo = await h.domain.tasks.create('AR', { title: 'Example change', repo: 'web' }, OWNER_ACTOR);
    const item = { type: 'task' as const, taskKey: withRepo.key };
    const developer = await h.domain.sessions.ensureSession('AR', 'dev-1', item);
    const files = await h.attachmentRules(withRepo.key);
    expect(h.runner.lastStarted().deniedTools).toEqual([...LOCAL_ONLY_DENIED_TOOLS, ...files.deny]);
    await h.domain.sessions.ensureSession('AR', 'cr', item);
    expect(h.runner.lastStarted()).toMatchObject({
      additionalDirectories: [developer.session.cwd],
      deniedTools: [...LOCAL_ONLY_DENIED_TOOLS, ...files.deny],
    });
    expect(h.runner.lastStarted().writableRoots).toBeUndefined();
    // A reviewer runs in a sandbox that writes only the temp directory (PM-167): its working
    // directory, the developer's worktree and every other worktree (PM-188) are read-only, the
    // credentials unreadable. A local-only repository has no pull request: no `gh` outside it.
    const reviewer = h.runner.lastStarted();
    expect(reviewer.policy!.access).toBe('read_only');
    expect(reviewer.sandbox).toEqual({
      allowWrite: [],
      denyWrite: [h.workspace, developer.session.cwd, join(h.dir, 'worktrees')],
      denyRead: reviewer.policy!.filesystem.deniedPaths,
      allowedDomains: ['registry.npmjs.org'],
      allowLocalBinding: true,
      env: SANDBOX_PTY_ENV,
    });
    expect(h.worktrees.calls).toHaveLength(1);
  });

  it('runs readers in their own mode, Auto too, in the read-only sandbox, chats included (PM-167)', async () => {
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      for (const member of draft.team.members) {
        if (member.kind !== 'ai') continue;
        member.permissionMode = 'auto';
        member.approver = 'none';
      }
      return 'Run every AI member in Auto with approver none';
    });
    const task = await h.domain.tasks.create('AR', { title: 'Example change', repo: 'web' }, OWNER_ACTOR);
    await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: task.key });
    const review = h.runner.lastStarted();
    expect(review.policy!.permissions).toEqual({
      claude: 'auto',
      sandbox: 'read-only',
      approval: 'on-request',
    });
    // On a repository on GitHub the pull request is read with `gh` outside the sandbox (PM-188).
    expect(review.sandbox).toMatchObject({
      allowWrite: [],
      denyWrite: [h.workspace, join(h.dir, 'worktrees')],
      excludedCommands: ['gh pr view', 'gh pr diff'],
    });

    // A developer's general chat reads only too: it runs outside its worktree.
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    const chat = h.runner.lastStarted();
    expect(chat.policy!.access).toBe('read_only');
    expect(chat.policy!.permissions.claude).toBe('auto');
    expect(chat.sandbox).toMatchObject({
      allowWrite: [],
      denyWrite: [h.workspace, join(h.dir, 'worktrees')],
    });
  });

  it('logs worktree lookup failures and starts the reviewer anyway', async () => {
    h.worktrees.find = async () => {
      throw new Error('Example lookup failure');
    };
    const withRepo = await h.domain.tasks.create('AR', { title: 'Example change', repo: 'web' }, OWNER_ACTOR);
    await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: withRepo.key });
    expect(h.runner.lastStarted().additionalDirectories).toBeUndefined();
    expect(h.log.warnings).toHaveLength(1);
  });

  it('applies the session policy of the new roles and of custom roles', async () => {
    const withRepo = await h.domain.tasks.create('AR', { title: 'With repo', repo: 'web' }, OWNER_ACTOR);
    const item = { type: 'task' as const, taskKey: withRepo.key };
    const hireBy = { actor: OWNER_ACTOR, author: OWNER, sponsor: 'owner' };
    await h.domain.members.hire('AR', { role: 'maintainer' }, hireBy);
    await h.domain.members.hire('AR', { role: 'architect' }, hireBy);
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      draft.team.roles.push({
        id: 'data_steward',
        name: 'Data steward',
        summary: 'Keeps data clean.',
        notTheirJob: '',
        holders: 'ai',
        instructions: '',
      });
      return 'Add a custom role';
    });
    await h.domain.members.hire('AR', { role: 'data_steward' }, hireBy);

    const maintainer = await h.domain.sessions.ensureSession('AR', 'maintainer', item);
    const files = await h.attachmentRules(withRepo.key);
    expect(maintainer.session.branch).toBe(`task/${withRepo.key}`);
    expect(h.runner.lastStarted()).toMatchObject({
      allowedTools: [...allowedToolsFor('maintainer', testConfig()), ...files.allow],
      permissionMode: 'auto',
    });

    const architect = await h.domain.sessions.ensureSession('AR', 'architect', item);
    expect(architect.session).toMatchObject({ cwd: h.workspace, branch: null });
    expect(h.runner.lastStarted().allowedTools).toContain('Bash(gh pr diff:*)');

    const steward = await h.domain.sessions.ensureSession('AR', 'data-steward', item);
    expect(steward.session).toMatchObject({ cwd: h.workspace, branch: null });
    expect(h.runner.lastStarted()).toMatchObject({
      allowedTools: ['mcp__team__*', ...files.allow],
      permissionMode: 'auto',
    });
  });

  it('marks live sessions as exited after a restart', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    h.runner.setState(session.id, 'working');
    await h.runner.shutdown();
    h.repos.sessions.update(session.id, { state: 'working' }); // simulate a crash: the row still says working
    h.domain.sessions.reconcileAfterRestart();
    expect(h.domain.sessions.get('AR', session.id).state).toBe('exited');
  });
});

describe("a developer's sandbox reads only its own work (PM-153)", () => {
  let h: DomainHarness | undefined;
  let home: string;
  let appHome: string;
  beforeEach(() => {
    // Fictional homes: nothing is read from or written to them, the paths only go into the spec.
    home = mkdtempSync(join(tmpdir(), 'pm-user-home-'));
    appHome = mkdtempSync(join(tmpdir(), 'pm-app-home-'));
  });
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
    rmSync(home, { recursive: true, force: true });
    rmSync(appHome, { recursive: true, force: true });
  });

  /** What every developer reads below its home besides its own directories. */
  const homeReads = () =>
    ['.gitconfig', '.config/git', '.claude/shell-snapshots'].map((name) => join(home, name));
  /** The member's own npm cache and development data (PM-193), below the app home. */
  const memberDirs = (app = appHome) => [
    join(app, 'member-caches', 'AR', 'dev-1', 'npm-cache'),
    join(app, 'member-caches', 'AR', 'dev-1', 'projectman-dev'),
  ];
  /** The git settings file of the member's sandbox directory (PM-216). */
  const memberGitConfig = (app = appHome) => join(dirname(memberDirs(app)[0]!), SANDBOX_GIT_CONFIG_FILE);
  const common = () => ({
    // Neither `~/.npm` (the host's `npx` runs code from its `_npx`) nor `~/.projectman-dev`.
    allowWrite: memberDirs(),
    env: {
      npm_config_cache: memberDirs()[0],
      PROJECTMAN_HOME: memberDirs()[1],
      ...SANDBOX_PTY_ENV,
      GIT_CONFIG_SYSTEM: memberGitConfig(),
    },
    deniedEnvVars: SANDBOX_DENIED_ENV_VARS,
    allowedDomains: ['registry.npmjs.org'],
    allowLocalBinding: true,
  });

  it('closes the homes, opens its worktree, the attachments and the shared git, and never writes the default branch', async () => {
    h = await createDomainHarness({ userHome: home, appHome });
    const task = await h.domain.tasks.create('AR', { title: 'With repo', repo: 'web' }, OWNER_ACTOR);
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: task.key });
    const spec = h.runner.lastStarted();
    const gitDir = join(h.workspace, '.git');
    const attachments = await h.attachmentStorage.taskDirectory('AR', task.key);
    expect(spec.policy!.placement).toMatchObject({ kind: 'task_worktree', path: spec.cwd, gitDir });
    expect(spec.sandbox).toEqual({
      ...common(),
      denyWrite: [
        join(gitDir, 'refs/heads/main'),
        join(gitDir, 'refs/heads/main.lock'),
        join(gitDir, 'HEAD'),
        join(gitDir, 'HEAD.lock'),
        join(gitDir, 'index'),
        join(gitDir, 'index.lock'),
        join(gitDir, 'packed-refs'),
        join(gitDir, 'packed-refs.lock'),
        // A replacement or graft would change what the default branch shows without moving it.
        join(gitDir, 'refs/replace'),
        join(gitDir, 'info/grafts'),
      ],
      // The app home is not below the user's home here, so it is closed on its own; the credentials
      // and the live data stay closed too: the narrower path wins over any re-opened one.
      denyRead: [home, appHome, ...sensitivePaths({ userHome: home, appHome })],
      allowRead: [spec.cwd, attachments, ...memberDirs(), memberGitConfig(), gitDir, ...homeReads()],
    });
    // Read-only for the commands, and written by the server at every start (PM-216).
    expect(spec.sandbox!.allowWrite).not.toContain(memberGitConfig());
    expect(readFileSync(memberGitConfig(), 'utf8')).toBe(SANDBOX_GIT_CONFIG);
    // The server makes the member's directories, which the sandbox could not make in a closed home.
    for (const dir of memberDirs()) expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('opens no attachment directory it cannot name, and lists an app home inside the home once', async () => {
    const inside = join(home, '.projectman');
    h = await createDomainHarness({
      userHome: home,
      appHome: inside,
      attachmentStorage: (inner) =>
        new Proxy(inner, {
          get: (target, prop, receiver) =>
            prop === 'taskDirectory'
              ? async () => '/fictional/attach(ments)'
              : (Reflect.get(target, prop, receiver) as unknown),
        }) as AttachmentStorage,
    });
    const task = await h.domain.tasks.create('AR', { title: 'With repo', repo: 'web' }, OWNER_ACTOR);
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: task.key });
    const spec = h.runner.lastStarted();
    expect(spec.sandbox!.denyRead).toEqual([home, ...sensitivePaths({ userHome: home, appHome: inside })]);
    expect(spec.sandbox!.allowRead).toEqual([
      spec.cwd,
      ...memberDirs(inside),
      memberGitConfig(inside),
      join(h.workspace, '.git'),
      ...homeReads(),
    ]);
    expect(spec.sandbox!.allowWrite).toEqual(memberDirs(inside));
  });

  it('writes nothing outside its worktree without an app home to keep its npm cache in (PM-193)', async () => {
    h = await createDomainHarness({ userHome: home });
    const task = await h.domain.tasks.create('AR', { title: 'With repo', repo: 'web' }, OWNER_ACTOR);
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: task.key });
    const sandbox = h.runner.lastStarted().sandbox!;
    expect(sandbox.allowWrite).toEqual([]);
    expect(sandbox.env).toEqual(SANDBOX_PTY_ENV);
  });

  it("reads the user's core.excludesfile and nothing else of the home (PM-216)", async () => {
    writeFileSync(join(home, '.gitconfig'), '[core]\n\texcludesfile = ~/.gitignore_global\n');
    writeFileSync(join(home, '.gitignore_global'), '*.log\n');
    h = await createDomainHarness({ userHome: home, appHome });
    const task = await h.domain.tasks.create('AR', { title: 'With repo', repo: 'web' }, OWNER_ACTOR);
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: task.key });
    const sandbox = h.runner.lastStarted().sandbox!;
    expect(sandbox.allowRead).toContain(join(home, '.gitignore_global'));
    expect(sandbox.allowRead).not.toContain(home);
    expect(sandbox.denyRead).toContain(home);
  });

  it("gives a reader no npm cache or development data of the member's (PM-193)", async () => {
    h = await createDomainHarness({ userHome: home, appHome });
    const task = await h.domain.tasks.create('AR', { title: 'With repo', repo: 'web' }, OWNER_ACTOR);
    await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: task.key });
    const sandbox = h.runner.lastStarted().sandbox!;
    expect(sandbox.allowWrite).toEqual([]);
    // Only the PTY-test signal (PM-194), none of the developer's directories.
    expect(sandbox.env).toEqual(SANDBOX_PTY_ENV);
    expect(existsSync(join(appHome, 'member-caches'))).toBe(false);
  });

  describe('in a member workstation (PM-138)', () => {
    const exec = promisify(execFile);
    const git = async (cwd: string, ...args: string[]) => {
      const env = { ...process.env };
      for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name];
      await exec('git', ['-C', cwd, ...args], { env });
    };
    let configDir: string;
    beforeAll(() => {
      configDir = mkdtempSync(join(tmpdir(), 'pm-gitconfig-'));
      const file = join(configDir, 'gitconfig');
      writeFileSync(
        file,
        '[user]\n\tname = projectman test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n',
      );
      vi.stubEnv('GIT_CONFIG_GLOBAL', file);
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    });
    afterAll(() => {
      vi.unstubAllEnvs();
      rmSync(configDir, { recursive: true, force: true });
    });

    it('has no shared git directory to protect: its own clone is in the working directory', async () => {
      h = await createDomainHarness({ userHome: home, appHome, memberWorkspaces: true });
      await git(h.workspace, 'init', '--quiet', '-b', 'main');
      writeFileSync(join(h.workspace, 'README.md'), 'hello\n');
      await git(h.workspace, 'add', 'README.md');
      await git(h.workspace, 'commit', '--quiet', '-m', 'Add README');
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      await h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
      const spec = h.runner.lastStarted();
      expect(spec.member).toBe('dev-1');
      expect(spec.cwd).toBe(join(await realpath(h.workspacesDir), 'AR', 'dev-1', 'web', 'repo'));
      expect(spec.policy!.placement).toMatchObject({ kind: 'task_worktree', path: spec.cwd });
      expect(spec.policy!.placement).not.toHaveProperty('gitDir');
      const attachments = await h.attachmentStorage.taskDirectory('AR', 'AR-1');
      expect(spec.sandbox).toEqual({
        ...common(),
        denyRead: [home, appHome, ...sensitivePaths({ userHome: home, appHome })],
        allowRead: [spec.cwd, attachments, ...memberDirs(), memberGitConfig(), ...homeReads()],
      });
    });
  });
});
