import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { questionPayloadOf } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { flush, settle } from './helpers/fakes';

const NOW = new Date('2026-10-19T10:00:00.000Z');
const owner = { handle: 'owner', access: 'owner' as const };
const todo = {
  question: 'The merge of AR-1 stands still',
  what: 'Merge AR-1 into main',
  where: 'The AR repository',
  expected: 'AR-1 merged and the card in Done',
};

function pmAvailable(config: ProjectConfig): void {
  const pm = config.team.members.find((m) => m.handle === 'pm')!;
  if (pm.kind === 'ai') pm.onLeave = false;
}

/**
 * PM-808: the project manager opens an integrator todo itself with `open_integrator_todo`, in the same queue
 * and in the same shape as the todo the system opens for an obligation (PM-806).
 */
describe('open_integrator_todo', () => {
  let h: DomainHarness;
  const integrator = { available: true };
  let pm: ToolContext;
  beforeEach(async () => {
    integrator.available = true;
    h = await createDomainHarness({
      adjust: pmAvailable,
      now: () => NOW,
      integratorTodoAccess: { available: () => integrator.available },
    });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    // The owner writes to the PM: its general conversation is the coordination session.
    await h.domain.messaging.sendReporting('AR', 'owner', { to: ['pm'], text: 'Please help' });
    await vi.waitFor(() => expect(h.domain.sessions.list('AR', { member: 'pm' })).toHaveLength(1), {
      timeout: 5000,
    });
    pm = {
      projectKey: 'AR',
      member: 'pm',
      sessionId: h.domain.sessions.list('AR', { member: 'pm' })[0]!.id,
      taskKey: null,
    };
    await settle();
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  const item = (id: string) => h.domain.inbox.get('AR', id);
  const open = (args: Partial<Parameters<typeof h.domain.teamTools.openIntegratorTodo>[1]> = {}, as = pm) =>
    h.domain.teamTools.openIntegratorTodo(as, { taskKey: 'AR-1', ...todo, ...args });

  it('opens the todo at the integrator and puts nothing in the owner inbox', async () => {
    const opened = await open();

    expect(opened).toEqual({ itemId: expect.any(String), recipient: 'integrator', recipientRefusal: null });
    expect(item(opened.itemId)).toMatchObject({
      kind: 'question',
      state: 'open',
      source: 'pm',
      taskKey: 'AR-1',
      title: todo.question,
      options: [{ id: 'todo_done' }, { id: 'todo_cannot' }],
    });
    expect(questionPayloadOf(item(opened.itemId))).toMatchObject({
      recipient: 'integrator',
      screening: {
        outcome: 'todo',
        todo: { what: todo.what, where: todo.where, expected: todo.expected, recipient: 'integrator' },
      },
    });
    expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(0);
  });

  it('works without a card', async () => {
    const opened = await open({ taskKey: undefined });
    expect(item(opened.itemId)).toMatchObject({ taskKey: null, state: 'open' });
  });

  it('gives the todo to the owners when the integrator is not available, and says why', async () => {
    integrator.available = false;
    const opened = await open();

    expect(opened.recipient).toBe('owner');
    expect(opened.recipientRefusal).toEqual(expect.any(String));
    expect(questionPayloadOf(item(opened.itemId))).toMatchObject({
      recipient: 'owner',
      screening: { recipientRefusal: opened.recipientRefusal },
    });
    expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(1);
  });

  async function developerContext(): Promise<ToolContext> {
    const started = await h.domain.taskStarts.start('AR', 'AR-1', {
      actor: OWNER_ACTOR,
      author: owner as never,
    });
    return { projectKey: 'AR', member: 'dev-1', sessionId: started.session!.id, taskKey: 'AR-1' };
  }
  const setMachineAccess = (handle: string, machineAccess: boolean) =>
    h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      const member = draft.team.members.find((m) => m.handle === handle);
      if (member?.kind === 'ai') member.machineAccess = machineAccess;
      return 'Set machine access';
    });

  it('refuses a member without machine access', async () => {
    const dev = await developerContext();
    const err = await rejection(open({}, dev), TeamToolError);
    expect(err.code).toBe('forbidden');
    expect(err.message).toContain('machine_access_required');
    expect(h.domain.inbox.list('AR', {}).filter((i) => i.source === 'dev-1')).toEqual([]);
  });

  it('refuses the project manager whose machine access an owner switched off', async () => {
    await setMachineAccess('pm', false);
    const err = await rejection(open(), TeamToolError);
    expect(err.message).toContain('machine_access_required');
  });

  it('lets a developer with machine access open a todo, and the answer returns to them', async () => {
    await setMachineAccess('dev-1', true);
    const dev = await developerContext();
    // The obligation check is the project manager's own: a developer's card is not refused for it.
    h.domain.obligations.open({
      projectKey: 'AR',
      taskKey: 'AR-1',
      kind: 'merge',
      responsible: 'cr',
      subject: 'mrg_AR-1',
      openedAt: NOW.toISOString(),
    });

    const opened = await open({}, dev);

    expect(opened.recipient).toBe('integrator');
    expect(item(opened.itemId)).toMatchObject({ source: 'dev-1', taskKey: 'AR-1', state: 'open' });
  });

  it('refuses a conversation with a guest', async () => {
    const session = h.repos.sessions.get(pm.sessionId)!;
    h.repos.sessions.insert({ ...session, id: 'ses_pm_guest', workItem: { type: 'general', with: 'dana' } });
    const err = await rejection(open({}, { ...pm, sessionId: 'ses_pm_guest' }), TeamToolError);
    expect(err.message).toContain('operator_owner_only');
  });

  it('refuses a card projectman follows itself, and writes nothing', async () => {
    h.domain.obligations.open({
      projectKey: 'AR',
      taskKey: 'AR-1',
      kind: 'merge',
      responsible: 'cr',
      subject: 'mrg_AR-1',
      openedAt: NOW.toISOString(),
    });
    const before = h.domain.inbox.list('AR', {}).length;

    const err = await rejection(open(), TeamToolError);

    expect(err.code).toBe('invalid');
    expect(err.message).toContain('obligation_tracked');
    expect(err.message).toContain('AR-1 is followed by projectman (merge, cr)');
    expect(h.domain.inbox.list('AR', {})).toHaveLength(before);
  });

  it('opens a todo on another card than the followed one', async () => {
    await h.domain.tasks.create('AR', { title: 'Second' }, OWNER_ACTOR);
    h.domain.obligations.open({
      projectKey: 'AR',
      taskKey: 'AR-1',
      kind: 'merge',
      responsible: 'cr',
      subject: 'mrg_AR-1',
      openedAt: NOW.toISOString(),
    });
    expect((await open({ taskKey: 'AR-2' })).recipient).toBe('integrator');
  });

  it('refuses empty and over-long fields at the tool boundary', async () => {
    const { TEAM_TOOLS } = await import('../src/mcp/tools');
    const tool = TEAM_TOOLS.find((t) => t.name === 'open_integrator_todo')!;
    const args = { task_key: 'AR-1', question: 'q', what: 'w', where: 'r', expected: 'e' };
    expect(tool.inputSchema.safeParse(args).success).toBe(true);
    for (const change of [
      { question: '' },
      { what: ' ' },
      { where: 'x'.repeat(501) },
      { expected: 'x'.repeat(1001) },
      { what: 'x'.repeat(2001) },
      { task_key: 'nope' },
      { member: 'owner' },
    ])
      expect(tool.inputSchema.safeParse({ ...args, ...change }).success).toBe(false);
  });

  it('brings the answer back to the project manager as the asker', async () => {
    integrator.available = false;
    const opened = await open();
    await flush();
    const before = h.runner.messages.length;

    await h.domain.inbox.resolve('AR', opened.itemId, { optionId: 'todo_done', note: 'Merged.' }, owner);
    await settle();

    expect(item(opened.itemId)).toMatchObject({ state: 'resolved', resolution: { optionId: 'todo_done' } });
    const typed = [
      ...h.runner.started.filter((s) => s.member === 'pm').map((s) => s.initialMessage ?? ''),
      ...h.runner.messages.slice(before).map((m) => m.text),
    ].join('\n');
    expect(typed).toContain('Merged.');
  });
});
