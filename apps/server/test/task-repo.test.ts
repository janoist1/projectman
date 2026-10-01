import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectConfig, ServerEvent, WorkItemRef } from '@projectman/shared';
import { createContextPackBuilder } from '../src/context';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { aiActor, LOCAL_ONLY_DENIED_TOOLS } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { settle } from './helpers/fakes';

/**
 * PM-68: where the work of a task without a repository of its own happens. The test project has one
 * repository, `web`; `twoRepos` gives it a second, so that a task has to name the one it works in.
 */
const twoRepos = (config: ProjectConfig): void => {
  config.project.repos.push({ name: 'api', path: 'api', github: 'acme/api', defaultBranch: 'main' });
};
const localOnly = (config: ProjectConfig): void => void delete config.project.repos[0]!.github;
const noRepos = (config: ProjectConfig): void => void (config.project.repos = []);

const onTask = (taskKey: string): WorkItemRef => ({ type: 'task', taskKey });
const code = async (promise: Promise<unknown>): Promise<string> => (await rejection(promise)).code;

describe('a task without a repository', () => {
  let h: DomainHarness;
  afterEach(() => h.cleanup());

  const worktreeOf = (taskKey: string, repo = 'web') => join(h.dir, 'worktrees', 'AR', `${taskKey}-${repo}`);
  const start = (taskKey: string, assignee?: string) =>
    h.domain.taskStarts.start('AR', taskKey, {
      assignee,
      actor: OWNER_ACTOR,
      author: OWNER,
      sponsor: 'owner',
    });

  describe('in a project with one repository', () => {
    it('runs a developer in the worktree of that repository, never in the workspace root', async () => {
      h = await createDomainHarness();
      const task = await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      expect(task.repo).toBeNull();

      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', onTask(task.key));

      expect(session).toMatchObject({ cwd: worktreeOf('AR-1'), branch: 'task/AR-1' });
      expect(session.cwd).not.toBe(h.workspace);
      expect(h.worktrees.calls).toEqual([{ repoName: 'web', taskKey: 'AR-1' }]);
      expect(h.runner.lastStarted()).toMatchObject({ cwd: worktreeOf('AR-1') });
      // The shared git directory is never made writable (PM-131).
      expect(h.runner.lastStarted().writableRoots).toBeUndefined();
      expect(h.domain.tasks.get('AR', 'AR-1').links).toContainEqual({
        kind: 'branch',
        ref: 'task/AR-1',
        repo: 'acme/web',
      });
      // The repository is worked out, not stored: a second repository later makes the task choose.
      expect(h.domain.tasks.get('AR', 'AR-1').repo).toBeNull();
    });

    it('starts the same way from a task start, for every role that changes files', async () => {
      h = await createDomainHarness();
      const hireBy = { actor: OWNER_ACTOR, author: OWNER, sponsor: 'owner' };
      await h.domain.members.hire('AR', { role: 'maintainer' }, hireBy);
      await h.domain.members.hire('AR', { role: 'docs' }, hireBy);
      for (const title of ['One', 'Two']) await h.domain.tasks.create('AR', { title }, OWNER_ACTOR);

      const started = await start('AR-1');
      expect(started.session).toMatchObject({ member: 'dev-1', cwd: worktreeOf('AR-1') });
      for (const handle of ['maintainer', 'docs']) {
        const { session } = await h.domain.sessions.ensureSession('AR', handle, onTask('AR-2'));
        expect(session.cwd, handle).toBe(worktreeOf('AR-2'));
      }
      expect(h.runner.started.map((spec) => spec.cwd)).not.toContain(h.workspace);
    });

    it('applies the local-only rules of that repository', async () => {
      h = await createDomainHarness({ adjust: localOnly });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);

      await h.domain.sessions.ensureSession('AR', 'dev-1', onTask('AR-1'));

      expect(h.runner.lastStarted()).toMatchObject({
        cwd: worktreeOf('AR-1'),
        deniedTools: LOCAL_ONLY_DENIED_TOOLS,
      });
      // No GitHub name, so the branch link has none either.
      expect(h.domain.tasks.get('AR', 'AR-1').links).toContainEqual({ kind: 'branch', ref: 'task/AR-1' });
      // The context pack the session gets words the steps without a pull request.
      const steps = createContextPackBuilder().build(h.contextBuilder.inputs.at(-1)!).appendSystemPrompt;
      expect(steps).toContain('Never push and never open a pull request: the repository is local-only');
      expect(steps).toContain('repo: `web`');
    });

    it('gives a reviewer the developer worktree to read, and the same denied tools', async () => {
      h = await createDomainHarness({ adjust: localOnly });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      await h.domain.sessions.ensureSession('AR', 'dev-1', onTask('AR-1'));

      const review = await h.domain.sessions.ensureSession('AR', 'cr', onTask('AR-1'));

      expect(review.session).toMatchObject({ cwd: h.workspace, branch: null });
      expect(h.runner.lastStarted()).toMatchObject({
        additionalDirectories: [worktreeOf('AR-1')],
        deniedTools: LOCAL_ONLY_DENIED_TOOLS,
      });
      expect(h.runner.lastStarted().writableRoots).toBeUndefined();
    });

    it('lets the automatic command rules work in that worktree', async () => {
      h = await createDomainHarness({ adjust: localOnly });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      const dev = (await h.domain.sessions.ensureSession('AR', 'dev-1', onTask('AR-1'))).session;
      const reviewer = (await h.domain.sessions.ensureSession('AR', 'cr', onTask('AR-1'))).session;
      const decide = (sessionId: string, command: string) =>
        h.runnerModule
          .broker()
          .decide(
            { sessionId, toolName: 'Bash', toolInput: { command }, raw: {} },
            new AbortController().signal,
          );

      // The developer commits in the worktree and cannot publish from the local-only repository ...
      expect(await decide(dev.id, 'git add -A && git commit -m "Add the login page"')).toEqual({
        behavior: 'allow',
      });
      expect(await decide(dev.id, 'git push origin HEAD')).toMatchObject({ behavior: 'deny' });
      // ... and the reviewer reads the worktree from the workspace, without asking.
      expect(await decide(reviewer.id, `cd ${worktreeOf('AR-1')} && git log -1 --oneline`)).toEqual({
        behavior: 'allow',
      });
      expect(h.domain.inbox.list('AR', { state: 'open' })).toEqual([]);
    });

    it('keeps a repository of its own: the project’s only one makes no difference', async () => {
      h = await createDomainHarness();
      const task = await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', onTask(task.key));
      expect(session.cwd).toBe(worktreeOf('AR-1'));
      expect(h.worktrees.calls).toEqual([{ repoName: 'web', taskKey: 'AR-1' }]);
    });
  });

  describe('in a project without repositories', () => {
    it('still works in the workspace root: there is no worktree to give it', async () => {
      h = await createDomainHarness({ adjust: noRepos });
      await h.domain.tasks.create('AR', { title: 'Notes' }, OWNER_ACTOR);

      const started = await start('AR-1');

      expect(started.session).toMatchObject({ member: 'dev-1', cwd: h.workspace, branch: null });
      expect(h.worktrees.calls).toEqual([]);
      expect(h.runner.lastStarted().deniedTools).toEqual([]);
    });
  });

  describe('in a project with several repositories', () => {
    it('refuses to start a developer on it, changes nothing and keeps nothing waiting', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);

      const err = await rejection(start('AR-1'));

      expect(err).toMatchObject({ code: 'repo_required', status: 409, details: { taskKey: 'AR-1' } });
      expect(err.message).toContain('has no repository and the project has several (web, api)');
      // The refusal comes before anything is done: no assignment, no move, no session, no worktree.
      expect(h.domain.tasks.get('AR', 'AR-1')).toMatchObject({ assignee: null, stageId: 'backlog' });
      expect(h.runner.started).toEqual([]);
      expect(h.worktrees.calls).toEqual([]);
      expect(h.domain.sessions.list('AR')).toEqual([]);
      expect(h.repos.deferredStarts.list()).toEqual([]);
    });

    it('starts the developer once the task names a repository, in that repository', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      expect(await code(start('AR-1'))).toBe('repo_required');

      await h.domain.tasks.update('AR', 'AR-1', { repo: 'api' }, OWNER_ACTOR);
      const started = await start('AR-1');

      expect(started.session).toMatchObject({ member: 'dev-1', cwd: worktreeOf('AR-1', 'api') });
      expect(h.worktrees.calls).toEqual([{ repoName: 'api', taskKey: 'AR-1' }]);
      expect(started.task.links).toContainEqual({ kind: 'branch', ref: 'task/AR-1', repo: 'acme/api' });
    });

    it('refuses the other ways a developer session would start too', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      const task = await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
      const first = await h.domain.sessions.ensureSession('AR', 'dev-1', onTask(task.key));
      await h.domain.sessions.stop('AR', first.session.id);
      await h.domain.tasks.update('AR', task.key, { repo: null }, OWNER_ACTOR);
      const started = h.runner.started.length;

      // A person writing to the stopped session resumes it, past admission: it still needs a repository.
      expect(await code(h.domain.messaging.sendToSession('AR', first.session.id, 'Carry on', 'owner'))).toBe(
        'repo_required',
      );
      expect(await code(h.domain.sessions.ensureSession('AR', 'dev-1', onTask(task.key)))).toBe(
        'repo_required',
      );
      expect(h.runner.started).toHaveLength(started);
    });

    it('does not start the developer for a message, and does not wait for a repository either', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);

      const message = await h.domain.messaging.send('AR', 'owner', {
        to: ['dev-1'],
        text: 'Please start on the login page.',
        taskKey: 'AR-1',
      });
      await settle();

      expect(h.runner.started).toEqual([]);
      // Only a person's choice clears the refusal, so the wake-up is not retried: nothing is kept.
      expect(h.repos.deferredStarts.list()).toEqual([]);
      expect(h.repos.messages.get(message.id)?.deliveredAt).toBeNull();
      expect(h.repos.messages.pending('AR', 'dev-1')).toHaveLength(1);
    });

    it('refuses before hiring a temp worker for it', async () => {
      h = await createDomainHarness({
        adjust: (config) => {
          twoRepos(config);
          config.team.limits.tempWorkers = { enabled: true, max: 1, role: 'developer' };
        },
      });
      for (const title of ['One', 'Two'])
        await h.domain.tasks.create('AR', { title, repo: 'web' }, OWNER_ACTOR);
      await h.domain.tasks.create('AR', { title: 'Three' }, OWNER_ACTOR);
      await start('AR-1');
      await start('AR-2');
      for (const spec of h.runner.started) h.runner.setState(spec.sessionId, 'idle');

      // Both developers are busy, so a temp worker would be hired for AR-3 ...
      await h.domain.tasks.update('AR', 'AR-3', { repo: 'api' }, OWNER_ACTOR);
      expect((await start('AR-3')).hired).toMatchObject({ handle: 'dev-3', temp: true });
      // ... but not while it has no repository.
      await h.domain.tasks.create('AR', { title: 'Four' }, OWNER_ACTOR);
      const before = (await h.domain.projects.config('AR')).team.members.length;
      expect(await code(start('AR-4'))).toBe('repo_required');
      expect((await h.domain.projects.config('AR')).team.members).toHaveLength(before);
    });

    it('still starts a reviewer in the workspace root, which only reads', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);

      const { session } = await h.domain.sessions.ensureSession('AR', 'cr', onTask('AR-1'));

      expect(session).toMatchObject({ cwd: h.workspace, branch: null });
      expect(h.worktrees.calls).toEqual([]);
      expect(h.runner.lastStarted().additionalDirectories).toBeUndefined();
      // It is told that no repository is chosen, rather than that the task works in the workspace root.
      const brief = h.contextBuilder.inputs.at(-1)!;
      expect(createContextPackBuilder().build(brief).initialMessage).toContain('- Repo: none chosen yet');
    });

    it('starts work that is not on a task: chats and scheduled runs', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      expect(session.cwd).toBe(h.workspace);
    });
  });

  describe('its waiting reason on the board', () => {
    const waiting = (taskKey = 'AR-1') => h.domain.tasks.get('AR', taskKey).startWaiting;
    /** A task in the work stage, assigned to an AI developer that has not started. */
    const assigned = async (handle = 'dev-1') => {
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      h.domain.tasks.assign('AR', 'AR-1', handle, OWNER_ACTOR);
      await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    };

    it('says that the developer waits for a repository to be chosen, until it is', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      const events: ServerEvent[] = [];
      h.domain.bus.subscribe((event) => events.push(event));
      await assigned();

      expect(waiting()).toMatchObject({
        reason: 'repo_required',
        member: 'dev-1',
        since: expect.any(String),
      });
      expect(h.domain.tasks.list('AR')[0]!.startWaiting?.reason).toBe('repo_required');

      await h.domain.tasks.update('AR', 'AR-1', { repo: 'api' }, OWNER_ACTOR);
      expect(waiting()).toBeUndefined();
      // The clients are told both ways: the moves and the choice publish the task as it reads now.
      const pushed = events.flatMap((event) =>
        event.type === 'task_upserted' ? [event.task.startWaiting?.reason] : [],
      );
      expect(pushed).toContain('repo_required');
      expect(pushed.at(-1)).toBeUndefined();
    });

    it('says nothing where nobody waits for the choice', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await assigned();
      expect(waiting()).toBeDefined();
      // A human carries the task; a reviewer needs no repository; other stages are not the developer's.
      h.domain.tasks.assign('AR', 'AR-1', 'owner', OWNER_ACTOR);
      expect(waiting()).toBeUndefined();
      h.domain.tasks.assign('AR', 'AR-1', 'cr', OWNER_ACTOR);
      expect(waiting()).toBeUndefined();
      h.domain.tasks.assign('AR', 'AR-1', 'dev-1', OWNER_ACTOR);
      await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
      expect(waiting()).toBeUndefined();
      await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
      expect(waiting()).toBeDefined();
      // Not for a task that is closed, and not for a project where the repository needs no choice.
      await h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
      expect(waiting()).toBeUndefined();
    });

    it('says nothing for a task that works in a repository, whatever the project has', async () => {
      h = await createDomainHarness();
      await assigned();
      expect(waiting()).toBeUndefined();
      await h.cleanup();
      h = await createDomainHarness({ adjust: noRepos });
      await assigned();
      expect(waiting()).toBeUndefined();
    });

    it('does not claim that a developer who is working waits', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      const task = await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
      h.domain.tasks.assign('AR', task.key, 'dev-1', OWNER_ACTOR);
      await h.domain.tasks.moveToStage('AR', task.key, 'development', OWNER_ACTOR);
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', onTask(task.key));
      // The choice is taken back by other means while the session runs: it is not waiting for it.
      h.repos.tasks.update(task.id, { repo: null });
      expect(waiting()).toBeUndefined();
      await h.domain.sessions.stop('AR', session.id);
      expect(waiting()).toMatchObject({ reason: 'repo_required', member: 'dev-1' });
    });
  });

  describe('setting its repository later', () => {
    const task = () => h.domain.tasks.get('AR', 'AR-1');
    const fieldEvents = () =>
      h.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((event) => event.type === 'task_updated');

    it('sets and clears it, and records each change on the timeline with who made it', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);

      const set = await h.domain.tasks.update('AR', 'AR-1', { repo: 'api' }, OWNER_ACTOR);
      expect(set.repo).toBe('api');
      expect(task().repo).toBe('api');
      expect(fieldEvents().at(-1)).toMatchObject({
        actor: { kind: 'human', handle: 'owner' },
        data: { fields: ['repo'], repo: 'api', previousRepo: null },
      });

      await h.domain.tasks.update('AR', 'AR-1', { repo: 'web' }, aiActor('cr'));
      expect(fieldEvents().at(-1)).toMatchObject({
        actor: { kind: 'ai', handle: 'cr' },
        data: { fields: ['repo'], repo: 'web', previousRepo: 'api' },
      });

      const cleared = await h.domain.tasks.update('AR', 'AR-1', { repo: null }, OWNER_ACTOR);
      expect(cleared.repo).toBeNull();
      expect(fieldEvents().at(-1)).toMatchObject({
        data: { fields: ['repo'], repo: null, previousRepo: 'web' },
      });
      expect(fieldEvents()).toHaveLength(3);
    });

    it('changes nothing and records nothing when the repository stays the same', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
      const before = task();

      await h.domain.tasks.update('AR', 'AR-1', { repo: 'web' }, OWNER_ACTOR);

      expect(task()).toEqual(before);
      expect(fieldEvents()).toEqual([]);
      // A task without a repository stays without one, in a project where that means the only one.
      await h.cleanup();
      h = await createDomainHarness();
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      await h.domain.tasks.update('AR', 'AR-1', { repo: null }, OWNER_ACTOR);
      expect(fieldEvents()).toEqual([]);
    });

    it('refuses a repository the project does not have, naming the ones it has', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);

      const err = await rejection(h.domain.tasks.update('AR', 'AR-1', { repo: 'mobile' }, OWNER_ACTOR));

      expect(err).toMatchObject({ code: 'unknown_repo', status: 400 });
      expect(err.message).toBe('unknown repository: mobile (the project has: web, api)');
      expect(task().repo).toBeNull();
      expect(fieldEvents()).toEqual([]);
      for (const repo of ['', ' web', 'WEB'])
        expect(await code(h.domain.tasks.update('AR', 'AR-1', { repo }, OWNER_ACTOR)), repo).toBe(
          'unknown_repo',
        );
    });

    it('applies the change all or nothing, with the other fields in one event', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);

      expect(
        await code(
          h.domain.tasks.update('AR', 'AR-1', { title: 'Sign-in page', repo: 'mobile' }, OWNER_ACTOR),
        ),
      ).toBe('unknown_repo');
      expect(task()).toMatchObject({ title: 'Login page', repo: null });

      await h.domain.tasks.update('AR', 'AR-1', { title: 'Sign-in page', repo: 'api' }, OWNER_ACTOR);
      expect(task()).toMatchObject({ title: 'Sign-in page', repo: 'api' });
      expect(fieldEvents().map((event) => event.data)).toEqual([
        { fields: ['title', 'repo'], repo: 'api', previousRepo: null },
      ]);
    });

    it('refuses the change while a session of the task is running, whoever runs it', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
      const dev = (await h.domain.sessions.ensureSession('AR', 'dev-1', onTask('AR-1'))).session;

      const err = await rejection(h.domain.tasks.update('AR', 'AR-1', { repo: 'api' }, OWNER_ACTOR));
      expect(err).toMatchObject({
        code: 'task_session_live',
        status: 409,
        details: { sessionId: dev.id },
      });
      expect(err.message).toBe(
        'the repository of task AR-1 cannot change while a session of the task is running',
      );
      expect(await code(h.domain.tasks.update('AR', 'AR-1', { repo: null }, OWNER_ACTOR))).toBe(
        'task_session_live',
      );
      expect(task().repo).toBe('web');
      expect(fieldEvents()).toEqual([]);
      // The same value is no change, so it needs no stopped session.
      await h.domain.tasks.update('AR', 'AR-1', { repo: 'web' }, OWNER_ACTOR);
      // A reviewer's session counts too; it was told where the worktree is.
      await h.domain.sessions.stop('AR', dev.id);
      const review = (await h.domain.sessions.ensureSession('AR', 'cr', onTask('AR-1'))).session;
      expect(await code(h.domain.tasks.update('AR', 'AR-1', { repo: 'api' }, OWNER_ACTOR))).toBe(
        'task_session_live',
      );
      await h.domain.sessions.stop('AR', review.id);

      await h.domain.tasks.update('AR', 'AR-1', { repo: 'api' }, OWNER_ACTOR);
      expect(task().repo).toBe('api');
    });

    it('refuses nothing when the sessions of the task have ended, failed ones included', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
      h.runner.failNextStart = new Error('spawn failed');
      await rejection(h.domain.sessions.ensureSession('AR', 'dev-1', onTask('AR-1')));
      expect(h.domain.sessions.list('AR')[0]!.state).toBe('failed');

      await h.domain.tasks.update('AR', 'AR-1', { repo: 'api' }, OWNER_ACTOR);

      expect(task().repo).toBe('api');
    });

    it('works through update_task for an AI member, attributed to it, with the same refusals', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      await h.domain.tasks.create('AR', { title: 'Reset page' }, OWNER_ACTOR);
      const planner: ToolContext = { projectKey: 'AR', member: 'cr', sessionId: 'ses_cr', taskKey: null };

      const { task: set } = await h.domain.teamTools.updateTask(planner, { taskKey: 'AR-1', repo: 'api' });
      expect(set.repo).toBe('api');
      expect(fieldEvents().at(-1)).toMatchObject({
        actor: { kind: 'ai', handle: 'cr' },
        sessionId: 'ses_cr',
        data: { fields: ['repo'], repo: 'api', previousRepo: null },
      });
      const { task: cleared } = await h.domain.teamTools.updateTask(planner, { taskKey: 'AR-1', repo: null });
      expect(cleared.repo).toBeNull();

      const unknown = await rejection(
        h.domain.teamTools.updateTask(planner, { taskKey: 'AR-1', repo: 'mobile' }),
        TeamToolError,
      );
      expect(unknown).toMatchObject({
        code: 'invalid',
        message: 'unknown repository: mobile (the project has: web, api)',
      });

      // The developer cannot move the task it works on to another repository: its own session is running.
      await h.domain.tasks.update('AR', 'AR-2', { repo: 'web' }, OWNER_ACTOR);
      const dev = (await h.domain.sessions.ensureSession('AR', 'dev-1', onTask('AR-2'))).session;
      const own: ToolContext = { projectKey: 'AR', member: 'dev-1', sessionId: dev.id, taskKey: 'AR-2' };
      const refused = await rejection(
        h.domain.teamTools.updateTask(own, { taskKey: 'AR-2', repo: 'api' }),
        TeamToolError,
      );
      expect(refused.message).toBe(
        'the repository of task AR-2 cannot change while a session of the task is running',
      );
    });

    it('shows get_task the repository the work happens in, and whether somebody has to choose', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      const reviewer: ToolContext = { projectKey: 'AR', member: 'cr', sessionId: 'ses_cr', taskKey: 'AR-1' };

      const choose = await h.domain.teamTools.getTask(reviewer, { taskKey: 'AR-1' });
      expect(choose).toMatchObject({ effectiveRepo: null, repoChoiceNeeded: true });
      expect(choose.task.repo).toBeNull();

      await h.domain.tasks.update('AR', 'AR-1', { repo: 'api' }, OWNER_ACTOR);
      expect(await h.domain.teamTools.getTask(reviewer, { taskKey: 'AR-1' })).toMatchObject({
        effectiveRepo: 'api',
        repoChoiceNeeded: false,
      });

      await h.cleanup();
      h = await createDomainHarness();
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      expect(await h.domain.teamTools.getTask(reviewer, { taskKey: 'AR-1' })).toMatchObject({
        effectiveRepo: 'web',
        repoChoiceNeeded: false,
      });
      await h.cleanup();
      h = await createDomainHarness({ adjust: noRepos });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      expect(await h.domain.teamTools.getTask(reviewer, { taskKey: 'AR-1' })).toMatchObject({
        effectiveRepo: null,
        repoChoiceNeeded: false,
      });
    });
  });

  describe('a repository that changes while a session starts', () => {
    /** The repository of the task changes once the worktree of the old one is ready, as in a race. */
    const changeDuringStart = (repo: string | null) => {
      const prepare = h.worktrees.ensureForTask.bind(h.worktrees);
      h.worktrees.ensureForTask = async (args) => {
        const worktree = await prepare(args);
        // No session of the task is recorded yet, so nothing refuses the change.
        await h.domain.tasks.update('AR', args.taskKey, { repo }, OWNER_ACTOR);
        return worktree;
      };
    };

    it('does not start in the worktree of the old repository, and starts in the new one when asked again', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
      changeDuringStart('api');

      const err = await rejection(h.domain.sessions.ensureSession('AR', 'dev-1', onTask('AR-1')));

      expect(err).toMatchObject({ code: 'session_start_failed', details: { taskKey: 'AR-1' } });
      expect(err.message).toContain('the repository of task AR-1 changed while the session was starting');
      expect(h.runner.started).toEqual([]);
      expect(h.domain.sessions.list('AR')).toEqual([]);
      expect(h.domain.tasks.get('AR', 'AR-1').repo).toBe('api');

      const again = await h.domain.sessions.ensureSession('AR', 'dev-1', onTask('AR-1'));
      expect(again.session.cwd).toBe(worktreeOf('AR-1', 'api'));
    });

    it('does not start a developer when the repository was cleared meanwhile', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
      changeDuringStart(null);

      expect(await code(h.domain.sessions.ensureSession('AR', 'dev-1', onTask('AR-1')))).toBe(
        'repo_required',
      );
      expect(h.runner.started).toEqual([]);
    });

    it('keeps a change that comes once the session is recorded out of the way', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);

      await h.domain.sessions.ensureSession('AR', 'dev-1', onTask('AR-1'));

      expect(await code(h.domain.tasks.update('AR', 'AR-1', { repo: 'api' }, OWNER_ACTOR))).toBe(
        'task_session_live',
      );
    });
  });

  describe('a session that ran somewhere else', () => {
    it('starts a new conversation in the worktree when it ran in the workspace root before', async () => {
      // Before PM-68 a developer on a task without a repository ran in the workspace root.
      h = await createDomainHarness({ adjust: noRepos });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      const before = (await h.domain.sessions.ensureSession('AR', 'dev-1', onTask('AR-1'))).session;
      h.runner.emit({ type: 'transcript_path', sessionId: before.id, path: '/tmp/root-conversation.jsonl' });
      await h.domain.sessions.stop('AR', before.id);
      expect(h.domain.sessions.get('AR', before.id)).toMatchObject({ cwd: h.workspace, branch: null });
      // The project now has one repository.
      await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
        draft.project.repos.push({ name: 'web', path: '.', github: 'acme/web', defaultBranch: 'main' });
        return 'Add the repository';
      });

      const again = await h.domain.sessions.ensureSession('AR', 'dev-1', onTask('AR-1'));

      expect(again).toMatchObject({ created: false, resumed: false, started: true });
      expect(again.session.id).toBe(before.id);
      expect(again.session).toMatchObject({
        cwd: join(h.dir, 'worktrees', 'AR', 'AR-1-web'),
        branch: 'task/AR-1',
      });
      expect(again.session.claudeSessionId).not.toBe(before.claudeSessionId);
      expect(again.session.transcriptPath).toBeNull();
      expect(h.runner.lastStarted()).toMatchObject({
        resume: false,
        cwd: again.session.cwd,
        claudeSessionId: again.session.claudeSessionId,
        initialMessage: 'Brief for AR-1: Login page',
      });
      expect(
        h.domain.timeline
          .list('AR', { taskKey: 'AR-1' })
          .filter((event) => event.type === 'session_started')
          .at(-1)?.data,
      ).toEqual({ member: 'dev-1', resumed: false });
    });

    it('starts a new conversation in the worktree of the new repository when the task changed repository', async () => {
      h = await createDomainHarness({ adjust: twoRepos });
      await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
      const before = (await h.domain.sessions.ensureSession('AR', 'dev-1', onTask('AR-1'))).session;
      h.runner.emit({ type: 'transcript_path', sessionId: before.id, path: '/tmp/web-conversation.jsonl' });
      await h.domain.sessions.stop('AR', before.id);

      await h.domain.tasks.update('AR', 'AR-1', { repo: 'api' }, OWNER_ACTOR);
      const again = await h.domain.sessions.ensureSession('AR', 'dev-1', onTask('AR-1'));

      expect(again.resumed).toBe(false);
      expect(again.session.cwd).toBe(join(h.dir, 'worktrees', 'AR', 'AR-1-api'));
      expect(h.runner.lastStarted()).toMatchObject({ resume: false, cwd: again.session.cwd });
      expect(h.worktrees.calls).toEqual([
        { repoName: 'web', taskKey: 'AR-1' },
        { repoName: 'api', taskKey: 'AR-1' },
      ]);
    });

    it('resumes the conversation when it ran in the worktree the task works in', async () => {
      h = await createDomainHarness();
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      const before = (await h.domain.sessions.ensureSession('AR', 'dev-1', onTask('AR-1'))).session;
      h.runner.emit({ type: 'transcript_path', sessionId: before.id, path: '/tmp/web-conversation.jsonl' });
      await h.domain.sessions.stop('AR', before.id);

      const again = await h.domain.sessions.ensureSession('AR', 'dev-1', onTask('AR-1'));

      expect(again).toMatchObject({ resumed: true });
      expect(again.session).toMatchObject({
        claudeSessionId: before.claudeSessionId,
        transcriptPath: '/tmp/web-conversation.jsonl',
        cwd: before.cwd,
      });
      expect(h.runner.lastStarted()).toMatchObject({ resume: true, claudeSessionId: before.claudeSessionId });
    });
  });
});
