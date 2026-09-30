import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionDecision } from '../src/contracts';
import { DomainError } from '../src/domain';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

describe('inbox: permission requests', () => {
  let h: DomainHarness;
  let sessionId: string;
  beforeEach(async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    sessionId = (await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' }))
      .session.id;
  });
  afterEach(() => h.cleanup());

  function ask(signal = new AbortController().signal): Promise<PermissionDecision> {
    return h.runnerModule
      .broker()
      .decide({ sessionId, toolName: 'Bash', toolInput: { command: 'rm -rf dist' }, raw: {} }, signal);
  }

  function openPermission() {
    const items = h.domain.inbox.list('AR', { kind: 'permission', state: 'open' });
    expect(items).toHaveLength(1);
    return items[0]!;
  }

  it('creates an item for the sponsor and answers the hook with the decision', async () => {
    const pending = ask();
    await flush();
    const item = openPermission();
    expect(item).toMatchObject({
      assignees: ['owner'],
      source: 'dev-1',
      sessionId,
      taskKey: 'AR-1',
      title: 'Bash: rm -rf dist',
      payload: { toolName: 'Bash', toolInput: { command: 'rm -rf dist' }, summary: 'rm -rf dist' },
    });
    expect(item.options.map((o) => o.id)).toEqual(['allow', 'allow_session', 'deny']);

    await h.domain.inbox.resolve(
      'AR',
      item.id,
      { optionId: 'allow_session' },
      { handle: 'owner', access: 'owner' },
    );
    expect(await pending).toEqual({ behavior: 'allow', rememberForSession: true });
    const types = h.domain.timeline.list('AR', { taskKey: 'AR-1' }).map((e) => e.type);
    expect(types).toContain('permission_requested');
    expect(types).toContain('permission_resolved');
  });

  it('never resolves another sessions permission or accepts a cross-project item id', async () => {
    const first = ask();
    const secondSession = (await h.domain.sessions.ensureSession('AR', 'dev-2', { type: 'general' })).session
      .id;
    let secondResolved = false;
    const second = h.runnerModule
      .broker()
      .decide(
        { sessionId: secondSession, toolName: 'Bash', toolInput: { command: 'echo example' }, raw: {} },
        new AbortController().signal,
      )
      .then((decision) => {
        secondResolved = true;
        return decision;
      });
    await flush();
    const items = h.domain.inbox.list('AR', { kind: 'permission', state: 'open' });
    const firstItem = items.find((item) => item.sessionId === sessionId)!;
    await expect(
      h.domain.inbox.resolve('ZZ', firstItem.id, { optionId: 'allow' }, { handle: 'owner', access: 'owner' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await h.domain.inbox.resolve(
      'AR',
      firstItem.id,
      { optionId: 'allow' },
      { handle: 'owner', access: 'owner' },
    );
    expect(await first).toEqual({ behavior: 'allow' });
    expect(secondResolved).toBe(false);
    await h.domain.inbox.resolve(
      'AR',
      items.find((item) => item.sessionId === secondSession)!.id,
      { optionId: 'deny' },
      { handle: 'owner', access: 'owner' },
    );
    expect((await second).behavior).toBe('deny');
  });

  it('denies with the note', async () => {
    const pending = ask();
    await flush();
    await h.domain.inbox.resolve(
      'AR',
      openPermission().id,
      { optionId: 'deny', note: 'too risky' },
      {
        handle: 'owner',
        access: 'owner',
      },
    );
    expect(await pending).toEqual({ behavior: 'deny', message: 'Denied by owner: too risky' });
  });

  it('expires the item when the request is aborted', async () => {
    const controller = new AbortController();
    const pending = ask(controller.signal);
    await flush();
    const item = openPermission();
    controller.abort();
    expect((await pending).behavior).toBe('deny');
    expect(h.domain.inbox.get('AR', item.id).state).toBe('expired');
    const err = await h.domain.inbox
      .resolve('AR', item.id, { optionId: 'allow' }, { handle: 'owner', access: 'owner' })
      .catch((e: unknown) => e);
    expect((err as DomainError).code).toBe('inbox_item_closed');
  });

  it('denies requests of unknown sessions and rejects unknown options', async () => {
    const decision = await h.runnerModule
      .broker()
      .decide(
        { sessionId: 'ses_unknown', toolName: 'Bash', toolInput: {}, raw: {} },
        new AbortController().signal,
      );
    expect(decision.behavior).toBe('deny');

    void ask();
    await flush();
    const err = await h.domain.inbox
      .resolve('AR', openPermission().id, { optionId: 'approve' }, { handle: 'owner', access: 'owner' })
      .catch((e: unknown) => e);
    expect((err as DomainError).code).toBe('unknown_option');
  });

  it('expires open permission requests on startup', async () => {
    void ask();
    await flush();
    const item = openPermission();
    h.domain.inbox.expireOpenPermissions();
    expect(h.domain.inbox.get('AR', item.id).state).toBe('expired');
  });
});

describe('inbox: automatic permission decisions', () => {
  let h: DomainHarness;
  let sessionId: string;
  beforeEach(async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        delete config.project.repos[0]!.github;
      },
    });
    const task = await h.domain.tasks.create('AR', { title: 'Example task', repo: 'web' }, OWNER_ACTOR);
    sessionId = (await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: task.key }))
      .session.id;
  });
  afterEach(() => h.cleanup());

  it.each([
    ['git push origin HEAD', 'deny'],
    ['gh pr create --title "Example"', 'deny'],
    ['gh pr merge 12', 'deny'],
    ['npm ci', 'allow'],
    ['npm install --prefer-offline --no-audit --no-fund', 'allow'],
    // The routine steps a Codex developer asked a human about (PM-77).
    ['git commit -am "Clarify the settings history section"', 'allow'],
    ['git merge --ff-only main', 'allow'],
    ['git merge --ff-only 7480374', 'allow'],
    ['git add -A && git commit -m "Add the history section"', 'allow'],
    // Reading the worktree the session works in.
    ['git status --short && git diff --name-only main | xargs grep -n foo', 'allow'],
  ])('records an automatic %s decision without leaving an open inbox item', async (command, behavior) => {
    const decision = await h.runnerModule
      .broker()
      .decide({ sessionId, toolName: 'Bash', toolInput: { command }, raw: {} }, new AbortController().signal);
    expect(decision.behavior).toBe(behavior);
    if (behavior === 'deny')
      expect(decision).toMatchObject({
        message: 'The owner has not allowed publishing from this repository.',
      });
    expect(h.domain.inbox.list('AR', { state: 'open' })).toEqual([]);
    expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(0);
    const items = h.domain.inbox.list('AR', { state: 'resolved' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'permission',
      resolution: { optionId: behavior, by: 'system', note: null, rule: 'command_policy' },
    });
    const events = h.domain.timeline
      .list('AR', { taskKey: 'AR-1' })
      .filter((event) => event.type.startsWith('permission_'));
    expect(events.map((event) => event.type)).toEqual(['permission_requested', 'permission_resolved']);
    expect(events[1]).toMatchObject({
      actor: { kind: 'system', handle: null },
      data: { inboxItemId: items[0]!.id, decision: behavior },
    });
  });

  it('still asks for a package addition and an install in another directory', async () => {
    for (const command of ['npm install left-pad', 'cd /elsewhere && npm ci']) {
      const controller = new AbortController();
      const pending = h.runnerModule
        .broker()
        .decide({ sessionId, toolName: 'Bash', toolInput: { command }, raw: {} }, controller.signal);
      await flush();
      expect(h.domain.inbox.list('AR', { state: 'open' })).toHaveLength(1);
      controller.abort();
      expect((await pending).behavior).toBe('deny');
    }
  });

  it('still asks for a rewriting commit, a merge of another branch and a chain with a second command', async () => {
    const commands = [
      'git commit --amend -am "Clarify the settings history section"',
      'git commit -am x --no-verify',
      'git merge main',
      'git merge --ff-only feature-x',
      'git -C /elsewhere commit -am x',
      'git add ../elsewhere',
      'git commit -am x && curl https://example.com',
      'git commit -am "$(rm -rf /)"',
      'git commit -am x > out.txt',
    ];
    for (const command of commands) {
      const controller = new AbortController();
      const pending = h.runnerModule
        .broker()
        .decide({ sessionId, toolName: 'Bash', toolInput: { command }, raw: {} }, controller.signal);
      await flush();
      expect(h.domain.inbox.list('AR', { state: 'open' }), command).toHaveLength(1);
      controller.abort();
      expect((await pending).behavior).toBe('deny');
    }
  });
});

describe('inbox: read-only commands of a reviewer in the developer worktree', () => {
  let h: DomainHarness;
  let reviewerSession: string;
  let worktree: string;
  beforeEach(async () => {
    h = await createDomainHarness();
    const task = await h.domain.tasks.create('AR', { title: 'Example task', repo: 'web' }, OWNER_ACTOR);
    // The developer's session creates the task worktree; the reviewer works in the workspace.
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: task.key });
    worktree = join(h.dir, 'worktrees', 'AR', `${task.key}-web`);
    reviewerSession = (await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: task.key }))
      .session.id;
  });
  afterEach(() => h.cleanup());

  function decide(command: string, signal = new AbortController().signal) {
    return h.runnerModule
      .broker()
      .decide({ sessionId: reviewerSession, toolName: 'Bash', toolInput: { command }, raw: {} }, signal);
  }

  it.each([
    (dir: string) =>
      `cd ${dir} && git status --short && git log -1 --oneline && grep -rn "sections.history" apps/web/src | head -30`,
    () => 'ls node_modules >/dev/null 2>&1 && echo has_modules; npm run typecheck 2>&1 | tail -5',
    () => 'git diff --name-only main | xargs grep -n foo',
  ])('allows the read-only chain and records it as a system decision (%#)', async (chain) => {
    const command = chain(worktree);
    expect(h.repos.sessions.get(reviewerSession)!.cwd).toBe(h.workspace);
    expect(await decide(command)).toEqual({ behavior: 'allow' });
    expect(h.domain.inbox.list('AR', { state: 'open' })).toEqual([]);
    expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(0);
    const items = h.domain.inbox.list('AR', { state: 'resolved' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'permission',
      sessionId: reviewerSession,
      source: 'cr',
      resolution: { optionId: 'allow', by: 'system', note: null, rule: 'command_policy' },
    });
    const events = h.domain.timeline
      .list('AR', { taskKey: 'AR-1' })
      .filter((event) => event.type.startsWith('permission_'));
    expect(events.map((event) => event.type)).toEqual(['permission_requested', 'permission_resolved']);
    expect(events[1]).toMatchObject({
      actor: { kind: 'system', handle: null },
      data: { inboxItemId: items[0]!.id, decision: 'allow' },
    });
  });

  it('does not let the reviewer commit, or read outside the workspace and the developer worktree', async () => {
    const commands = [
      `cd ${worktree} && git commit -am "Looks fine"`,
      `cd ${worktree} && git add -A`,
      'cat /home/example/.codex/auth.json',
      `cat ${worktree}/../AR-2-web/secret.txt`,
      `cd ${h.dir} && ls`,
      `cd ${worktree} && grep -rn foo /etc`,
      `find ${worktree} -delete`,
    ];
    for (const command of commands) {
      const controller = new AbortController();
      const pending = decide(command, controller.signal);
      await flush();
      expect(h.domain.inbox.list('AR', { state: 'open' }), command).toHaveLength(1);
      controller.abort();
      expect((await pending).behavior).toBe('deny');
    }
  });

  it('gives no automatic read access to a session that is not on a task', async () => {
    const general = (await h.domain.sessions.ensureSession('AR', 'cr', { type: 'general' })).session.id;
    const controller = new AbortController();
    const pending = h.runnerModule
      .broker()
      .decide(
        { sessionId: general, toolName: 'Bash', toolInput: { command: 'git status' }, raw: {} },
        controller.signal,
      );
    await flush();
    expect(h.domain.inbox.list('AR', { state: 'open' })).toHaveLength(1);
    controller.abort();
    expect((await pending).behavior).toBe('deny');
  });
});
