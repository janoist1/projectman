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
});
