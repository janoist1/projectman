import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem, ProjectConfig } from '@projectman/shared';
import type { PermissionDecision, ToolContext } from '../src/contracts';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush, planUsage } from './helpers/fakes';

/**
 * "When it asks, an AI decides" on the host (PM-169): the question of a member whose approver is `ai`
 * goes to the member holding the boundary authorization duty, unless it is one of the owner's
 * categories or there is nobody to decide; a person gets everything else, and whatever is left when
 * the time is up.
 */

function configure(
  config: ProjectConfig,
  opts: { approver?: 'ai' | 'human'; boundary?: boolean; extra?: (config: ProjectConfig) => void } = {},
) {
  config.team.boundary = { enabled: opts.boundary !== false, leadTimeoutSeconds: 120 };
  config.team.roles.push({
    id: 'custom_lead',
    name: 'Custom lead',
    summary: 'Authorize external operations',
    duties: ['boundary_authorization', 'code_review'],
    holders: 'both',
    instructions: '',
    notTheirJob: '',
  });
  for (const member of config.team.members) {
    if (member.handle === 'cr' && member.kind === 'ai') member.role = 'custom_lead';
    if (member.handle === 'dev-1' && member.kind === 'ai') member.approver = opts.approver ?? 'ai';
  }
  opts.extra?.(config);
}

describe('permission questions delegated to the AI decider (PM-169)', () => {
  let h: DomainHarness;
  let now: Date;
  let sessionId: string;
  afterEach(() => h?.cleanup());

  async function start(extra?: (config: ProjectConfig) => void, opts: { boundary?: boolean } = {}) {
    now = new Date('2026-10-01T11:00:00.000Z');
    h = await createDomainHarness({
      now: () => now,
      adjust: (config) => configure(config, { ...opts, extra }),
    });
    await h.domain.tasks.create('AR', { title: 'Example task', repo: 'web' }, OWNER_ACTOR);
    sessionId = (await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' }))
      .session.id;
  }

  const ask = (
    command: string,
    signal = new AbortController().signal,
    session = sessionId,
    toolName = 'Bash',
  ): Promise<PermissionDecision> =>
    h.runnerModule.broker().decide({ sessionId: session, toolName, toolInput: { command }, raw: {} }, signal);
  const openPermissions = () => h.domain.inbox.list('AR', { kind: 'permission', state: 'open' });
  const onlyOpen = (): InboxItem => {
    const open = openPermissions();
    expect(open).toHaveLength(1);
    return open[0]!;
  };
  const tool = (member: string, session = sessionId): ToolContext => ({
    projectKey: 'AR',
    member,
    sessionId: session,
    taskKey: 'AR-1',
  });
  const decide = (
    member: string,
    item: InboxItem,
    decision: 'allow' | 'deny' | 'escalate',
    reason = 'Routine step of the task.',
  ) => h.domain.teamTools.decidePermissionRequest(tool(member), { requestId: item.id, decision, reason });
  const permissionEvents = () =>
    h.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((e) => e.type.startsWith('permission_'));

  describe('the decider', () => {
    beforeEach(() => start());

    it('keeps two different permission subjects actionable and wakes their decider once', async () => {
      h.runnerModule.planUsage.value = planUsage(95);
      const first = new AbortController();
      const second = new AbortController();
      const pending = [
        ask('curl https://example.com/one', first.signal),
        ask('curl https://example.com/two', second.signal),
      ];
      await flush();
      expect(openPermissions()).toHaveLength(2);
      const messages = h.repos.messages.pending('AR', 'cr');
      expect(messages).toHaveLength(2);
      const config = await h.domain.projects.config('AR');
      for (const message of messages) expect(h.domain.messages.wakes(config, message, 'cr')).toBe(true);
      h.runnerModule.planUsage.value = planUsage(30);
      await h.domain.admission.retryDeferred();
      await flush();
      expect(h.domain.sessions.list('AR', { member: 'cr' })).toHaveLength(1);
      expect(h.runner.lastStarted().initialMessage).toContain('2 messages waited for you; 0 are out of date');
      await h.domain.admission.retryDeferred();
      expect(h.domain.sessions.list('AR', { member: 'cr' })).toHaveLength(1);
      first.abort();
      second.abort();
      await Promise.all(pending);
    });

    it('holds AI messages with the current decider, then delivers one batch after permission and the turn end', async () => {
      h.runner.setState(sessionId, 'waiting_permission');
      const pending = ask('curl https://example.com/data.json');
      await flush();
      const item = onlyOpen();
      for (const text of ['One', 'Two', 'Three']) {
        const sent = await h.domain.messaging.sendReporting('AR', 'dev-2', {
          to: ['dev-1'],
          taskKey: 'AR-1',
          text,
        });
        expect(sent.recipients).toMatchObject([
          {
            handle: 'dev-1',
            delivery: 'after_turn',
            waitingPermission: { inboxItemId: item.id, deciders: ['cr'], since: item.createdAt },
          },
        ]);
      }
      expect(h.runner.messages.filter((m) => m.sessionId === sessionId)).toHaveLength(0);
      const detail = await h.domain.teamTools.getTask(tool('cr'), { taskKey: 'AR-1' });
      expect(detail.cardWorkers?.find((w) => w.handle === 'dev-1')?.waitingPermission?.deciders).toEqual([
        'cr',
      ]);
      // A human message still follows the existing immediate queue path.
      await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], taskKey: 'AR-1', text: 'Owner note' });
      await flush();
      expect(h.runner.messages.filter((m) => m.sessionId === sessionId)).toHaveLength(1);
      await decide('cr', item, 'allow');
      expect(await pending).toEqual({ behavior: 'allow' });
      h.runner.setState(sessionId, 'working');
      await flush();
      expect(h.runner.messages.filter((m) => m.sessionId === sessionId)).toHaveLength(1);
      h.runner.setState(sessionId, 'idle');
      await vi.waitFor(() =>
        expect(h.runner.messages.filter((m) => m.sessionId === sessionId)).toHaveLength(2),
      );
      const delivered = h.runner.messages.filter((m) => m.sessionId === sessionId);
      expect(delivered).toHaveLength(2);
      expect(delivered[1]!.text).toContain('3 messages waited for you');
      for (const text of ['One', 'Two', 'Three']) expect(delivered[1]!.text).toContain(text);
      expect(h.repos.messages.pending('AR', 'dev-1')).toHaveLength(0);
    });

    it('expires the inbox item and refuses a late decision without answering the CLI twice', async () => {
      const controller = new AbortController();
      let answers = 0;
      const pending = ask('curl https://example.com/data.json', controller.signal).then((decision) => {
        answers++;
        return decision;
      });
      await flush();
      const item = onlyOpen();
      controller.abort();
      expect((await pending).behavior).toBe('deny');
      expect(h.domain.inbox.get('AR', item.id).state).toBe('expired');
      await expect(
        h.domain.inbox.resolveDelegated('AR', item.id, 'cr', { decision: 'allow', reason: 'Late answer' }),
      ).rejects.toMatchObject({ code: 'inbox_item_closed', details: { id: item.id, state: 'expired' } });
      await expect(decide('cr', item, 'allow')).rejects.toMatchObject({
        message: expect.stringContaining('expired — nothing reached the session'),
      });
      expect(answers).toBe(1);
    });

    it('does not wake a deferred decider after its permission subject escalates', async () => {
      h.runnerModule.planUsage.value = planUsage(95);
      const controller = new AbortController();
      const pending = ask('curl https://example.com/data.json', controller.signal);
      await flush();
      const item = onlyOpen();
      now = new Date(now.getTime() + 121_000);
      await h.domain.inbox.sweepDelegations();
      const config = await h.domain.projects.config('AR');
      const message = h.repos.messages
        .list('AR', { member: 'cr' })
        .find((m) => m.subject?.inboxItemId === item.id)!;
      expect(h.domain.messages.wakes(config, message, 'cr')).toBe(false);
      expect(h.domain.sessions.list('AR', { member: 'cr' })).toHaveLength(0);
      controller.abort();
      await pending;
    });

    it('gets the question, with the exact input, instead of the owner, and is woken to answer it', async () => {
      const controller = new AbortController();
      const pending = ask('curl https://example.com/data.json', controller.signal);
      await flush();
      const item = onlyOpen();
      expect(item.assignees).toEqual(['cr']);
      expect(item.payload).toMatchObject({
        toolName: 'Bash',
        toolInput: { command: 'curl https://example.com/data.json' },
        delegation: { state: 'pending_lead', leads: ['cr'], leadDeadline: '2026-10-01T11:02:00.000Z' },
      });
      expect(item.payload).not.toHaveProperty('ownerCategory');
      // Nothing for a person to do while the decider has the question.
      expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(0);
      expect(h.domain.sessions.list('AR', { member: 'cr', taskKey: 'AR-1' })).toHaveLength(1);
      const message = h.repos.messages.list('AR', { member: 'cr' }).at(-1)!;
      expect(message.body).toContain(`Permission request ${item.id}`);
      expect(message.body).toContain('curl https://example.com/data.json');
      expect(message.body).toContain('decide_permission_request');
      expect(message.body).toContain('2026-10-01T11:02:00.000Z');
      controller.abort();
      expect((await pending).behavior).toBe('deny');
    });

    it('allows: the CLI continues, and the item and the timeline say who decided, why and when', async () => {
      const pending = ask('curl https://example.com/data.json');
      await flush();
      const item = onlyOpen();
      now = new Date('2026-10-01T11:00:30.000Z');
      const answer = await decide('cr', item, 'allow', 'A plain download inside the task.');
      expect(answer).toMatchObject({ requestId: item.id, decision: 'allow' });
      expect(await pending).toEqual({ behavior: 'allow' });

      const closed = h.domain.inbox.get('AR', item.id);
      expect(closed).toMatchObject({
        state: 'resolved',
        resolution: {
          optionId: 'allow',
          by: 'cr',
          at: '2026-10-01T11:00:30.000Z',
          note: 'A plain download inside the task.',
        },
      });
      // The owner finds the decision among the recent items.
      expect(closed.assignees).toEqual(expect.arrayContaining(['cr', 'owner']));
      expect(permissionEvents()).toMatchObject([
        { type: 'permission_requested', actor: { kind: 'ai', handle: 'dev-1' } },
        {
          type: 'permission_resolved',
          actor: { kind: 'ai', handle: 'cr' },
          data: {
            inboxItemId: item.id,
            decision: 'allow',
            delegated: true,
            reason: 'A plain download inside the task.',
          },
        },
      ]);
    });

    it('denies: the CLI is refused with the decider and its reason', async () => {
      const pending = ask('curl https://example.com/data.json');
      await flush();
      const item = onlyOpen();
      await decide('cr', item, 'deny', 'The task does not need this download.');
      expect(await pending).toEqual({
        behavior: 'deny',
        message: 'Denied by cr: The task does not need this download.',
      });
      expect(h.domain.inbox.get('AR', item.id).resolution).toMatchObject({ optionId: 'deny', by: 'cr' });
      expect(permissionEvents().at(-1)).toMatchObject({
        actor: { kind: 'ai', handle: 'cr' },
        data: { decision: 'deny', delegated: true, reason: 'The task does not need this download.' },
      });
    });

    it('escalates: the question comes to the sponsor with the reason, still waiting, and a person decides', async () => {
      let settled = false;
      const pending = ask('curl https://example.com/data.json').then((decision) => {
        settled = true;
        return decision;
      });
      await flush();
      const item = onlyOpen();
      await decide('cr', item, 'escalate', 'I cannot tell what the script does.');
      await flush();
      expect(settled).toBe(false);
      const handed = onlyOpen();
      expect(handed.assignees).toEqual(['owner']);
      expect(handed.payload).toMatchObject({ delegation: { state: 'pending_owner' } });
      expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(1);
      expect(permissionEvents().at(-1)).toMatchObject({
        type: 'permission_escalated',
        actor: { kind: 'ai', handle: 'cr' },
        data: {
          inboxItemId: item.id,
          cause: 'lead',
          assignees: ['owner'],
          reason: 'I cannot tell what the script does.',
        },
      });
      // The decider has no say any more.
      await expect(decide('cr', handed, 'allow')).rejects.toMatchObject({ code: 'forbidden' });
      await h.domain.inbox.resolve(
        'AR',
        item.id,
        { optionId: 'allow' },
        { handle: 'owner', access: 'owner' },
      );
      expect(await pending).toEqual({ behavior: 'allow' });
      expect(permissionEvents().at(-1)).toMatchObject({
        type: 'permission_resolved',
        actor: { kind: 'human', handle: 'owner' },
      });
    });

    it('is refused the answer for a request it did not get, twice, or without a reason', async () => {
      const pending = ask('curl https://example.com/data.json');
      await flush();
      const item = onlyOpen();
      // Another AI member, the requester itself and a missing reason.
      await expect(decide('dev-2', item, 'allow')).rejects.toMatchObject({ code: 'forbidden' });
      await expect(decide('dev-1', item, 'allow')).rejects.toMatchObject({ code: 'forbidden' });
      await expect(
        h.domain.inbox.resolveDelegated('AR', item.id, 'cr', { decision: 'allow', reason: ' ' }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(openPermissions()).toHaveLength(1);
      await decide('cr', item, 'allow');
      expect(await pending).toEqual({ behavior: 'allow' });
      await expect(decide('cr', item, 'deny')).rejects.toMatchObject({ code: 'invalid' });
    });
  });

  describe('what no AI decides', () => {
    beforeEach(() => start());

    it.each([
      ['npm publish --access public', 'production'],
      ['git push origin HEAD', 'production'],
      ['gh pr merge 12 --squash', 'production'],
      ['bash deploy/vm/bootstrap.sh', 'production'],
      ['curl http://127.0.0.1:4800/api/projects', 'production'],
      ['cat ~/.ssh/id_ed25519', 'credentials'],
      ['gh auth token', 'credentials'],
      ['sudo launchctl list', 'host_expansion'],
      ['brew install jq', 'host_expansion'],
    ])('goes to the sponsor with no wake-up of the decider: %s', async (command, category) => {
      const controller = new AbortController();
      const pending = ask(command, controller.signal);
      await flush();
      const item = onlyOpen();
      expect(item.assignees).toEqual(['owner']);
      expect(item.payload).toMatchObject({ ownerCategory: category });
      expect(item.payload).not.toHaveProperty('delegation');
      expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(1);
      expect(h.domain.sessions.list('AR', { member: 'cr' })).toHaveLength(0);
      // The decider cannot take it, even by its id.
      await expect(decide('cr', item, 'allow')).rejects.toMatchObject({ code: 'forbidden' });
      controller.abort();
      expect((await pending).behavior).toBe('deny');
    });

    it('sends a file tool writing outside the session to the owner, and one inside to the decider', async () => {
      const controller = new AbortController();
      const outside = h.runnerModule
        .broker()
        .decide(
          { sessionId, toolName: 'Write', toolInput: { file_path: '/etc/hosts', content: 'x' }, raw: {} },
          controller.signal,
        );
      await flush();
      expect(onlyOpen()).toMatchObject({
        assignees: ['owner'],
        payload: { ownerCategory: 'host_expansion' },
      });
      controller.abort();
      await outside;

      const cwd = h.repos.sessions.get(sessionId)!.cwd;
      const inside = new AbortController();
      const written = h.runnerModule.broker().decide(
        {
          sessionId,
          toolName: 'Write',
          toolInput: { file_path: `${cwd}/src/new.ts`, content: 'x' },
          raw: {},
        },
        inside.signal,
      );
      await flush();
      const open = openPermissions();
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({
        assignees: ['cr'],
        payload: { delegation: { state: 'pending_lead' } },
      });
      inside.abort();
      await written;
    });

    it.each([
      ['an email through another MCP server', 'mcp__claude_ai_Gmail__send_message', { to: 'a@example.com' }],
      [
        'a Codex patch outside the session',
        'apply_patch',
        { input: '*** Begin Patch\n*** Add File: /Users/someone/.zshrc\n+x\n*** End Patch' },
      ],
      [
        'a request too long to be shown whole',
        'Bash',
        { command: `curl https://example.com/?q=${'x'.repeat(5000)}` },
      ],
    ])('goes to the owner, never to the decider: %s', async (_what, toolName, toolInput) => {
      const controller = new AbortController();
      const pending = h.runnerModule
        .broker()
        .decide({ sessionId, toolName, toolInput, raw: {} }, controller.signal);
      await flush();
      const item = onlyOpen();
      expect(item.assignees).toEqual(['owner']);
      expect(item.payload).not.toHaveProperty('delegation');
      expect(h.domain.sessions.list('AR', { member: 'cr' })).toHaveLength(0);
      controller.abort();
      await pending;
    });

    it('sends a Codex patch inside the session to the decider', async () => {
      const controller = new AbortController();
      const pending = h.runnerModule.broker().decide(
        {
          sessionId,
          toolName: 'apply_patch',
          toolInput: { input: '*** Begin Patch\n*** Add File: notes.txt\n+hello\n*** End Patch' },
          raw: {},
        },
        controller.signal,
      );
      await flush();
      expect(onlyOpen()).toMatchObject({ assignees: ['cr'] });
      controller.abort();
      await pending;
    });

    it('leaves the command rules first: a routine step is allowed and an in-place edit refused as before', async () => {
      expect(await ask('git status --short')).toEqual({ behavior: 'allow' });
      expect((await ask("sed -i 's/a/b/' src/a.ts")).behavior).toBe('deny');
      expect(h.domain.inbox.list('AR', { state: 'open' })).toEqual([]);
      expect(h.domain.sessions.list('AR', { member: 'cr' })).toHaveLength(0);
    });
  });

  describe('without a decider to ask', () => {
    it('sends the decider’s own request to the owner', async () => {
      await start();
      const own = (await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-1' }))
        .session.id;
      await h.domain.members.update(
        'AR',
        'cr',
        { onLeave: false },
        { actor: OWNER_ACTOR, author: { name: 'Owner', email: 'owner@example.com' } },
      );
      // `cr` holds the duty and has approver ai through the configuration: there is nobody else.
      await h.domain.projects.update(
        'AR',
        { actor: OWNER_ACTOR, author: { name: 'Owner', email: 'owner@example.com' } },
        (config) => {
          const cr = config.team.members.find((m) => m.handle === 'cr');
          if (cr?.kind === 'ai') cr.approver = 'ai';
          return 'The decider asks the AI';
        },
      );
      const controller = new AbortController();
      const pending = ask('curl https://example.com/data.json', controller.signal, own);
      await flush();
      expect(onlyOpen()).toMatchObject({ source: 'cr', assignees: ['owner'] });
      expect(onlyOpen().payload).not.toHaveProperty('delegation');
      controller.abort();
      await pending;
    });

    it('sends it to the owner while the decider is on leave', async () => {
      await start((config) => {
        const cr = config.team.members.find((m) => m.handle === 'cr');
        if (cr?.kind === 'ai') cr.onLeave = true;
      });
      const controller = new AbortController();
      const pending = ask('curl https://example.com/data.json', controller.signal);
      await flush();
      expect(onlyOpen()).toMatchObject({ assignees: ['owner'] });
      expect(h.domain.sessions.list('AR', { member: 'cr' })).toHaveLength(0);
      controller.abort();
      await pending;
    });

    describe('when the AI team is switched off', () => {
      const switchAi = (aiEnabled: boolean) =>
        h.domain.projects.update(
          'AR',
          { actor: OWNER_ACTOR, author: { name: 'Owner', email: 'owner@example.com' } },
          (config) => {
            config.team.limits.aiEnabled = aiEnabled;
            return `Switch the AI team ${aiEnabled ? 'on' : 'off'}`;
          },
        );

      it('sends a new question to the owner, as no decider is at work', async () => {
        await start();
        await switchAi(false);
        const controller = new AbortController();
        const pending = ask('curl https://example.com/data.json', controller.signal);
        await flush();
        expect(onlyOpen()).toMatchObject({ assignees: ['owner'] });
        expect(onlyOpen().payload).not.toHaveProperty('delegation');
        expect(h.domain.sessions.list('AR', { member: 'cr' })).toHaveLength(0);
        controller.abort();
        await pending;
      });

      it('hands a question the decider has to the owner', async () => {
        await start();
        const controller = new AbortController();
        const pending = ask('curl https://example.com/data.json', controller.signal);
        await flush();
        expect(onlyOpen().assignees).toEqual(['cr']);
        await switchAi(false);
        await flush();
        expect(onlyOpen().assignees).toEqual(['owner']);
        expect(permissionEvents().at(-1)).toMatchObject({
          type: 'permission_escalated',
          data: { cause: 'timeout' },
        });
        controller.abort();
        await pending;
      });
    });

    it('sends it to the owner when delegation is switched off', async () => {
      await start(undefined, { boundary: false });
      const controller = new AbortController();
      const pending = ask('curl https://example.com/data.json', controller.signal);
      await flush();
      expect(onlyOpen()).toMatchObject({ assignees: ['owner'] });
      expect(onlyOpen().payload).not.toHaveProperty('delegation');
      controller.abort();
      await pending;
    });

    it('does not delegate for a member whose approver is a person', async () => {
      now = new Date('2026-10-01T11:00:00.000Z');
      h = await createDomainHarness({
        now: () => now,
        adjust: (config) => configure(config, { approver: 'human' }),
      });
      await h.domain.tasks.create('AR', { title: 'Example task', repo: 'web' }, OWNER_ACTOR);
      sessionId = (await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' }))
        .session.id;
      const controller = new AbortController();
      const pending = ask('curl https://example.com/data.json', controller.signal);
      await flush();
      const item = onlyOpen();
      expect(item.assignees).toEqual(['owner']);
      // No AI decides it, delegation or not: not even the member holding the duty.
      await expect(decide('cr', item, 'allow')).rejects.toMatchObject({ code: 'forbidden' });
      controller.abort();
      await pending;
    });
  });

  describe('when the decider does not answer', () => {
    beforeEach(() => start());

    it('hands the question to the owner at the deadline, and never allows it', async () => {
      let settled = false;
      const pending = ask('curl https://example.com/data.json').then((decision) => {
        settled = true;
        return decision;
      });
      await flush();
      const item = onlyOpen();
      now = new Date('2026-10-01T11:01:59.000Z');
      await h.domain.inbox.sweepDelegations();
      expect(onlyOpen().assignees).toEqual(['cr']);
      now = new Date('2026-10-01T11:02:00.000Z');
      await h.domain.inbox.sweepDelegations();
      await flush();
      expect(settled).toBe(false);
      expect(onlyOpen()).toMatchObject({ id: item.id, assignees: ['owner'] });
      expect(onlyOpen().payload).toMatchObject({ delegation: { state: 'pending_owner' } });
      expect(permissionEvents().at(-1)).toMatchObject({
        type: 'permission_escalated',
        actor: { kind: 'system', handle: null },
        data: { cause: 'timeout', assignees: ['owner'] },
      });
      // Sweeping again changes nothing.
      await h.domain.inbox.sweepDelegations();
      expect(permissionEvents().filter((e) => e.type === 'permission_escalated')).toHaveLength(1);
      // A late answer is refused and does not open the question again.
      await expect(decide('cr', item, 'allow')).rejects.toMatchObject({ code: 'forbidden' });
      expect(settled).toBe(false);
      await h.domain.inbox.resolve('AR', item.id, { optionId: 'deny' }, { handle: 'owner', access: 'owner' });
      expect((await pending).behavior).toBe('deny');
    });

    it('refuses a late answer even before a sweep ran, and hands the question over', async () => {
      const controller = new AbortController();
      const pending = ask('curl https://example.com/data.json', controller.signal);
      await flush();
      const item = onlyOpen();
      now = new Date('2026-10-01T11:05:00.000Z');
      await expect(decide('cr', item, 'allow')).rejects.toMatchObject({ code: 'forbidden' });
      expect(onlyOpen().assignees).toEqual(['owner']);
      expect(permissionEvents().at(-1)).toMatchObject({
        type: 'permission_escalated',
        data: { cause: 'timeout' },
      });
      controller.abort();
      await pending;
    });

    it('hands it over when the decider goes on leave while it waits', async () => {
      const controller = new AbortController();
      const pending = ask('curl https://example.com/data.json', controller.signal);
      await flush();
      await h.domain.members.update(
        'AR',
        'cr',
        { onLeave: true },
        { actor: OWNER_ACTOR, author: { name: 'Owner', email: 'owner@example.com' } },
      );
      await flush();
      expect(onlyOpen().assignees).toEqual(['owner']);
      expect(permissionEvents().at(-1)).toMatchObject({
        type: 'permission_escalated',
        data: { cause: 'timeout' },
      });
      controller.abort();
      await pending;
    });

    it('lets the owner answer at any time, in their own name', async () => {
      const pending = ask('curl https://example.com/data.json');
      await flush();
      const item = onlyOpen();
      await h.domain.inbox.resolve(
        'AR',
        item.id,
        { optionId: 'allow' },
        { handle: 'owner', access: 'owner' },
      );
      expect(await pending).toEqual({ behavior: 'allow' });
      expect(permissionEvents().at(-1)).toMatchObject({ actor: { kind: 'human', handle: 'owner' } });
      await expect(decide('cr', item, 'allow')).rejects.toMatchObject({ code: 'invalid' });
    });
  });

  describe('what an AI never decides', () => {
    beforeEach(() => start());

    it('is not a gate decision, a question or an item of a person’s', async () => {
      const question = h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        assignees: ['owner'],
        source: 'dev-1',
        title: 'Which one?',
        payload: { question: 'Which one?' },
        options: [{ id: 'answer', label: 'answer', style: 'secondary' }],
      });
      const decision = h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'decision',
        assignees: ['owner'],
        source: 'dev-1',
        title: 'Merge',
        payload: {},
        options: [{ id: 'approve', label: 'approve', style: 'primary' }],
      });
      const personsPermission = h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'permission',
        assignees: ['owner'],
        source: 'dev-2',
        title: 'Bash: ls',
        payload: { toolName: 'Bash', toolInput: { command: 'ls' }, summary: 'ls' },
        options: [{ id: 'allow', label: 'allow', style: 'primary' }],
      });
      for (const item of [question, decision, personsPermission]) {
        await expect(decide('cr', item, 'allow'), item.kind).rejects.toMatchObject({ code: 'forbidden' });
        await expect(
          h.domain.inbox.resolve(
            'AR',
            item.id,
            { optionId: item.options[0]!.id, note: 'x' },
            {
              handle: 'cr',
              access: 'developer',
            },
          ),
        ).rejects.toMatchObject({ code: 'ai_approval_forbidden' });
        expect(h.domain.inbox.get('AR', item.id).state).toBe('open');
      }
    });
  });
});
