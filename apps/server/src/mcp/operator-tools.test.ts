import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../contracts';
import type { Actor } from '@projectman/shared';
import { createDomainHarness, OWNER_ACTOR, waitForSession } from '../../test/helpers/domain-harness';
import type { DomainHarness } from '../../test/helpers/domain-harness';
import { settle } from '../../test/helpers/fakes';
import { TEAM_TOOLS, toolOutputText } from './tools';
import { createFakeTeamToolsHandler, devContext } from './testing';

describe('Operator MCP tools', () => {
  it('reads a required built-in role through a strict read-only tool', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'get_role_configuration')!;
    const handler = createFakeTeamToolsHandler();
    expect(tool.annotations.readOnlyHint).toBe(true);
    const args = tool.inputSchema.parse({ role: 'developer' });
    expect(JSON.parse(toolOutputText(await tool.run({ ctx: devContext, args, handler })))).toEqual({
      version: 'v1',
      role: 'developer',
      override: null,
      effective: { duties: ['implementation'], instructions: '' },
    });
    expect(handler.calls).toEqual([{ method: 'getRoleConfiguration', ctx: devContext, args }]);
    for (const input of [{}, { role: null }, { role: 'custom_writer' }, { role: 'developer', project: 'BR' }])
      expect(tool.inputSchema.safeParse(input).success).toBe(false);
    const operation = TEAM_TOOLS.find((t) => t.name === 'operate')!;
    expect(
      operation.inputSchema.parse({
        title: 'Reset',
        operation: {
          op: 'config_patch',
          patch: { roleOverrides: { developer: null } },
        },
      }),
    ).toMatchObject({ operation: { patch: { roleOverrides: { developer: null } } } });
  });
  it('triage_loop is strict, validates evidence and forwards only assessment fields', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'triage_loop')!;
    const handler = createFakeTeamToolsHandler();
    const args = tool.inputSchema.parse({
      signal_id: 'ops_loop',
      outcome: 'progress',
      note: '  Review is advancing.  ',
    });
    expect(JSON.parse(toolOutputText(await tool.run({ ctx: devContext, args, handler })))).toEqual({
      state: 'observing',
      loop_id: 'loop_1',
      inbox_item_id: null,
    });
    expect(handler.calls[0]).toMatchObject({
      method: 'triageLoop',
      args: {
        signalId: 'ops_loop',
        outcome: 'progress',
        note: 'Review is advancing.',
        evidenceIds: [],
      },
    });
    for (const change of [
      { note: ' ' },
      { note: 'x'.repeat(2001) },
      { outcome: 'let_run' },
      { outcome: 'stop_work' },
      { loop_id: 'other' },
      { member: 'owner' },
      { evidence_ids: ['same', 'same'] },
      { evidence_ids: Array(21).fill('event') },
    ])
      expect(
        tool.inputSchema.safeParse({ signal_id: 'ops_loop', outcome: 'progress', note: 'Review.', ...change })
          .success,
      ).toBe(false);
  });
  it('combine_questions validates distinct bounded ids and preserves the public argument names', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'combine_questions')!;
    const handler = createFakeTeamToolsHandler();
    const input = { item_ids: ['q1', 'q2'], question: '  Shared decision?  ', note: '  Same decision  ' };
    const args = tool.inputSchema.parse(input);
    expect(JSON.parse(toolOutputText(await tool.run({ ctx: devContext, args, handler })))).toEqual({
      primary_item_id: 'q1',
      linked_item_ids: ['q2'],
    });
    expect(handler.calls[0]).toMatchObject({
      method: 'combineQuestions',
      args: {
        itemIds: ['q1', 'q2'],
        question: 'Shared decision?',
        note: 'Same decision',
      },
    });
    for (const item_ids of [['q1'], ['q1', 'q1'], Array.from({ length: 11 }, (_, i) => `q${i}`)])
      expect(tool.inputSchema.safeParse({ ...input, item_ids }).success).toBe(false);
  });
  it('dismiss_signal validates its bounds, trims the note and returns the dismissal', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'dismiss_signal')!;
    const handler = createFakeTeamToolsHandler();
    const args = tool.inputSchema.parse({ signal_id: 'ops_1', note: '  Parked on purpose.  ' });
    expect(JSON.parse(toolOutputText(await tool.run({ ctx: devContext, args, handler })))).toEqual({
      signal_id: 'ops_1',
      state: 'dismissed',
    });
    expect(handler.calls[0]).toMatchObject({
      method: 'dismissSignal',
      args: { signalId: 'ops_1', note: 'Parked on purpose.' },
    });
    for (const input of [
      { signal_id: '', note: 'reason' },
      { signal_id: 'x'.repeat(65), note: 'reason' },
      { signal_id: 'ops_1', note: ' ' },
      { signal_id: 'ops_1', note: 'x'.repeat(1001) },
    ])
      expect(tool.inputSchema.safeParse(input).success).toBe(false);
  });
  it('reassign_task and cancel_task require a bounded reason and forward the card changes', async () => {
    const reassign = TEAM_TOOLS.find((t) => t.name === 'reassign_task')!;
    const cancel = TEAM_TOOLS.find((t) => t.name === 'cancel_task')!;
    const handler = createFakeTeamToolsHandler();
    const reassignArgs = reassign.inputSchema.parse({
      task_key: 'AR-1',
      assignee: 'dev-1',
      reason: '  Capacity moved.  ',
    });
    await reassign.run({ ctx: devContext, args: reassignArgs, handler });
    await cancel.run({
      ctx: devContext,
      args: cancel.inputSchema.parse({ task_key: 'AR-1', reason: 'Obsolete' }),
      handler,
    });
    expect(handler.calls).toMatchObject([
      { method: 'reassignTask', args: { taskKey: 'AR-1', assignee: 'dev-1', reason: 'Capacity moved.' } },
      { method: 'cancelTask', args: { taskKey: 'AR-1', reason: 'Obsolete' } },
    ]);
    expect(
      reassign.inputSchema.safeParse({ task_key: 'AR-1', assignee: null, reason: 'Unassign' }).success,
    ).toBe(true);
    for (const input of [
      { task_key: 'AR-1', assignee: 'dev-1' },
      { task_key: 'AR-1', assignee: 'dev-1', reason: ' ' },
      { task_key: 'AR-1', assignee: 'dev-1', reason: 'x'.repeat(501) },
    ])
      expect(reassign.inputSchema.safeParse(input).success).toBe(false);
    for (const input of [{ task_key: 'AR-1' }, { task_key: 'AR-1', reason: 'x'.repeat(501) }])
      expect(cancel.inputSchema.safeParse(input).success).toBe(false);
  });
  it('open_integrator_todo forwards the todo fields and tells who got it', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'open_integrator_todo')!;
    const handler = createFakeTeamToolsHandler();
    const args = tool.inputSchema.parse({
      task_key: 'AR-1',
      question: ' The merge stands still ',
      what: 'Merge AR-1',
      where: 'The repo',
      expected: 'AR-1 in Done',
    });
    expect(toolOutputText(await tool.run({ ctx: devContext, args, handler }))).toBe(
      'Integrator todo inb_todo_1 opened for integrator.',
    );
    expect(handler.calls[0]).toMatchObject({
      method: 'openIntegratorTodo',
      args: {
        taskKey: 'AR-1',
        question: 'The merge stands still',
        what: 'Merge AR-1',
        where: 'The repo',
        expected: 'AR-1 in Done',
      },
    });
  });
  it.each(['send_message', 'start_member'])(
    '%s describes and forwards the parallel-work confirmation',
    async (name) => {
      const tool = TEAM_TOOLS.find((t) => t.name === name)!;
      expect(tool.description).toContain(
        'If the message would put a member to work on a card where a member of the same role already works, nothing is sent and the result names them; send again with despite_workers: true only if the parallel work is intended.',
      );
      const handler = createFakeTeamToolsHandler();
      const input =
        name === 'send_message'
          ? { to: ['cr'], kind: 'action', text: 'Review' }
          : { member: 'cr', text: 'Review' };
      await tool.run({
        ctx: devContext,
        args: tool.inputSchema.parse({ ...input, despite_workers: true }),
        handler,
      });
      expect(handler.calls[0]).toMatchObject({ args: { despiteWorkers: true } });
      expect(tool.inputSchema.safeParse(input).success).toBe(true);
      expect(tool.inputSchema.safeParse({ ...input, despite_workers: 'yes' }).success).toBe(false);
    },
  );
  it('forwards multiple signals and validates list bounds', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'send_message')!;
    const handler = createFakeTeamToolsHandler();
    const input = {
      to: ['owner'],
      kind: 'info',
      text: 'Summary',
      signal_ids: ['a', 'b'],
      actionable_signal_ids: ['b'],
    };
    await tool.run({ ctx: devContext, args: tool.inputSchema.parse(input), handler });
    expect(handler.calls[0]).toMatchObject({ args: { signalIds: ['a', 'b'], actionableSignalIds: ['b'] } });
    expect(tool.inputSchema.safeParse({ ...input, signal_ids: [] }).success).toBe(false);
    expect(
      tool.inputSchema.safeParse({ ...input, signal_ids: Array.from({ length: 21 }, (_, i) => String(i)) })
        .success,
    ).toBe(false);
  });
  it('forwards optional signal presentation arguments without changing ordinary message calls', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'send_message')!;
    const handler = createFakeTeamToolsHandler();
    const args = tool.inputSchema.parse({
      to: ['owner'],
      kind: 'info',
      text: 'System proposal',
      signal_id: 'ops_1',
      signal_actionable: true,
    });
    await tool.run({ ctx: devContext, args, handler });
    expect(handler.calls[0]).toMatchObject({
      method: 'sendMessage',
      args: { signalId: 'ops_1', signalActionable: true },
    });
  });
  it('validates and forwards the operation and title and returns the step result', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'operate')!;
    const handler = createFakeTeamToolsHandler();
    const args = tool.inputSchema.parse({
      title: '  Change the writer  ',
      operation: { op: 'member_update', handle: 'dev-1', changes: { model: 'sonnet', capacity: 2 } },
    });
    const result = JSON.parse(toolOutputText(await tool.run({ ctx: devContext, args, handler })));
    expect(result).toEqual({ status: 'done', step_id: 'ops_fake', changes: [] });
    expect(handler.calls[0]).toMatchObject({
      method: 'operate',
      ctx: devContext,
      args: { ...args, title: 'Change the writer' },
    });
    expect(tool.inputSchema.safeParse({ title: '', operation: { op: 'project_pause' } }).success).toBe(false);
    expect(
      tool.inputSchema.safeParse({ title: 'x'.repeat(121), operation: { op: 'project_pause' } }).success,
    ).toBe(false);
    expect(tool.inputSchema.safeParse({ title: 'Change', operation: { op: 'unknown' } }).success).toBe(false);
  });

  it('read_project_doc forwards the part asked for, and is a read tool', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'read_project_doc')!;
    expect(tool.annotations.readOnlyHint).toBe(true);
    const handler = createFakeTeamToolsHandler();
    const args = tool.inputSchema.parse({ doc: 'decisions', from_line: 5, line_count: 10 });
    expect(JSON.parse(toolOutputText(await tool.run({ ctx: devContext, args, handler })))).toMatchObject({
      doc: 'decisions',
      from_line: 5,
    });
    expect(handler.calls[0]).toMatchObject({
      method: 'readProjectDoc',
      args: { doc: 'decisions', fromLine: 5, lineCount: 10 },
    });
    expect(tool.inputSchema.safeParse({ doc: 'readme' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ doc: 'roadmap', from_line: 0 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ doc: 'roadmap', line_count: 2001 }).success).toBe(false);
  });

  it('write_project_docs validates the commit, the one-line message and the edits, and forwards them', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'write_project_docs')!;
    expect(tool.annotations.readOnlyHint).toBe(false);
    const handler = createFakeTeamToolsHandler();
    const edit = { doc: 'decisions', old_text: '', new_text: '3. Third' };
    const input = { base_commit: 'a'.repeat(40), message: '  Add decision 3  ', edits: [edit] };
    const args = tool.inputSchema.parse(input);
    expect(JSON.parse(toolOutputText(await tool.run({ ctx: devContext, args, handler })))).toMatchObject({
      write_id: 'dw_fake',
    });
    expect(handler.calls[0]).toMatchObject({
      method: 'writeProjectDocs',
      args: { baseCommit: 'a'.repeat(40), message: 'Add decision 3', edits: [edit] },
    });
    const refused = (changes: Record<string, unknown>) =>
      tool.inputSchema.safeParse({ ...input, ...changes }).success;
    expect(refused({ base_commit: 'main' })).toBe(false);
    expect(refused({ base_commit: 'A'.repeat(40) })).toBe(false);
    expect(refused({ message: '' })).toBe(false);
    expect(refused({ message: 'two\nlines' })).toBe(false);
    expect(refused({ message: 'x'.repeat(201) })).toBe(false);
    expect(refused({ edits: [] })).toBe(false);
    expect(refused({ edits: Array.from({ length: 21 }, () => edit) })).toBe(false);
    expect(refused({ edits: [{ ...edit, new_text: '' }] })).toBe(false);
    expect(refused({ edits: [{ ...edit, old_text: 'x'.repeat(20001) }] })).toBe(false);
    expect(refused({ edits: [{ ...edit, doc: 'readme' }] })).toBe(false);
    expect(refused({ edits: [{ ...edit, extra: 1 }] })).toBe(false);
  });

  it('list_decision_candidates is a read tool that forwards the limit (1..50)', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'list_decision_candidates')!;
    expect(tool.annotations.readOnlyHint).toBe(true);
    const handler = createFakeTeamToolsHandler();
    const args = tool.inputSchema.parse({ limit: 5 });
    expect(JSON.parse(toolOutputText(await tool.run({ ctx: devContext, args, handler })))).toEqual({
      candidates: [],
      more: false,
    });
    expect(handler.calls[0]).toMatchObject({ method: 'listDecisionCandidates', args: { limit: 5 } });
    expect(tool.inputSchema.safeParse({}).success).toBe(true);
    expect(tool.inputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ limit: 51 }).success).toBe(false);
  });

  it('mark_decision_candidates takes 1..50 verdicts and the entry number only with recorded', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'mark_decision_candidates')!;
    expect(tool.annotations.readOnlyHint).toBe(false);
    const handler = createFakeTeamToolsHandler();
    const items = [
      { item_id: 'inb_1', verdict: 'recorded', decision: '52' },
      { item_id: 'inb_2', verdict: 'declined' },
    ];
    const args = tool.inputSchema.parse({ items });
    expect(JSON.parse(toolOutputText(await tool.run({ ctx: devContext, args, handler })))).toEqual({
      marked: 2,
    });
    expect(handler.calls[0]).toMatchObject({ method: 'markDecisionCandidates', args: { items } });
    const refused = (list: unknown[]) => tool.inputSchema.safeParse({ items: list }).success;
    expect(refused([])).toBe(false);
    expect(refused(Array.from({ length: 51 }, () => items[1]))).toBe(false);
    expect(refused([{ item_id: 'inb_1', verdict: 'declined', decision: '52' }])).toBe(false);
    expect(refused([{ item_id: 'inb_1', verdict: 'recorded', decision: 'x'.repeat(11) }])).toBe(false);
    expect(refused([{ item_id: 'inb_1', verdict: 'maybe' }])).toBe(false);
  });

  it('screen_question takes the fields of its outcome only and forwards them (PM-558)', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'screen_question')!;
    expect(tool.annotations.readOnlyHint).toBe(false);
    const handler = createFakeTeamToolsHandler();
    const todo = {
      what: 'Renew the certificate',
      where: 'Hosting panel',
      expected: 'The new expiry date',
      recipient: 'owner',
    };
    const args = tool.inputSchema.parse({
      item_id: 'inb_1',
      outcome: 'todo',
      note: 'Needs a login',
      todo,
      feedback_id: 'fb_1',
    });
    expect(JSON.parse(toolOutputText(await tool.run({ ctx: devContext, args, handler })))).toEqual({
      inboxItemId: 'inb_1',
      outcome: 'todo',
      recipient: 'owner',
    });
    expect(handler.calls[0]).toMatchObject({
      method: 'screenQuestion',
      args: { itemId: 'inb_1', outcome: 'todo', note: 'Needs a login', todo, feedbackId: 'fb_1' },
    });
    const ok = (input: Record<string, unknown>) =>
      tool.inputSchema.safeParse({ item_id: 'inb_1', note: 'Why', ...input }).success;
    expect(ok({ outcome: 'moot' })).toBe(true);
    expect(ok({ outcome: 'answered', answer: 'Yes' })).toBe(true);
    expect(ok({ outcome: 'forwarded', forward_to: 'dev-1' })).toBe(true);
    expect(ok({ outcome: 'answered' })).toBe(false);
    expect(ok({ outcome: 'moot', answer: 'Yes' })).toBe(false);
    expect(ok({ outcome: 'forwarded' })).toBe(false);
    expect(ok({ outcome: 'decision', forward_to: 'dev-1' })).toBe(false);
    expect(ok({ outcome: 'todo' })).toBe(false);
    expect(ok({ outcome: 'todo', todo, feedback_id: '' })).toBe(false);
    expect(ok({ outcome: 'decision', feedback_id: 'fb_1' })).toBe(false);
    expect(ok({ outcome: 'decision', todo })).toBe(false);
    expect(ok({ outcome: 'decision', note: '' })).toBe(false);
    expect(ok({ outcome: 'maybe' })).toBe(false);
  });

  it('maps start_task arguments to the shared start handler', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'start_task')!;
    const handler = createFakeTeamToolsHandler();
    const args = tool.inputSchema.parse({ task_key: 'AR-1', assignee: 'dev-1', despite_prerequisites: true });
    expect(JSON.parse(toolOutputText(await tool.run({ ctx: devContext, args, handler })))).toEqual({
      task_key: 'AR-1',
      session_id: null,
      hired: null,
      assignee: 'dev-1',
    });
    expect(handler.calls[0]).toMatchObject({
      method: 'startTask',
      ctx: devContext,
      args: { taskKey: 'AR-1', assignee: 'dev-1', despitePrerequisites: true },
    });
    expect(tool.inputSchema.safeParse({ task_key: 'invalid' }).success).toBe(false);
  });

  it('passes the signal id of start_task and start_member only when it is given (PM-545)', async () => {
    const task = TEAM_TOOLS.find((t) => t.name === 'start_task')!;
    const member = TEAM_TOOLS.find((t) => t.name === 'start_member')!;
    const handler = createFakeTeamToolsHandler();
    await task.run({
      ctx: devContext,
      args: task.inputSchema.parse({ task_key: 'AR-1', signal_id: 'ops_1' }),
      handler,
    });
    expect(handler.calls[0]!.args).toEqual({ taskKey: 'AR-1', signalId: 'ops_1' });
    await member.run({
      ctx: devContext,
      args: member.inputSchema.parse({ member: 'dev-1', text: 'Go.', task_key: 'AR-1', signal_id: 'ops_1' }),
      handler,
    });
    expect(handler.calls[1]!.args).toEqual({
      member: 'dev-1',
      text: 'Go.',
      taskKey: 'AR-1',
      signalId: 'ops_1',
    });
    expect(task.inputSchema.safeParse({ task_key: 'AR-1', signal_id: '' }).success).toBe(false);
    expect(member.inputSchema.safeParse({ member: 'dev-1', text: 'Go.', task_key: 'x' }).success).toBe(false);
  });

  it('validates start_member and reports the member delivery in one line', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'start_member')!;
    expect(tool.annotations.readOnlyHint).toBe(false);
    const handler = createFakeTeamToolsHandler();
    const args = tool.inputSchema.parse({ member: 'dev-1', text: 'Check the engine.' });
    const output = toolOutputText(await tool.run({ ctx: devContext, args, handler }));
    expect(output).toContain('dev-1: typed into their session now.');
    expect(output).toContain('Message msg_fake');
    expect(output).toContain('general conversation');
    expect(output).not.toContain('\n');
    expect(handler.calls[0]).toMatchObject({ method: 'startMember', ctx: devContext, args });
    expect(tool.inputSchema.safeParse({ ...args, text: '' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ ...args, text: 'x'.repeat(20001) }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ ...args, text: 'x'.repeat(20000) }).success).toBe(true);
  });
});

describe('dismiss_signal authorization and domain errors', () => {
  let h: DomainHarness;
  let operator: ToolContext;
  beforeEach(async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        const pm = config.team.members.find((m) => m.handle === 'pm')!;
        if (pm.kind === 'ai') pm.onLeave = false;
        config.team.members.push({
          kind: 'human',
          handle: 'guest',
          displayName: 'Guest',
          access: 'developer',
          roles: [],
        });
        config.pipeline.stages.splice(1, 0, {
          id: 'ready',
          name: 'Ready',
          kind: 'queue',
          columnId: 'todo',
          owners: ['owner'],
        });
      },
    });
    const { session } = await h.domain.sessions.ensureSession('AR', 'pm', { type: 'general' });
    operator = { projectKey: 'AR', member: 'pm', sessionId: session.id, taskKey: null };
  });
  afterEach(async () => {
    await h?.cleanup();
  });

  it('rejects a non-Operator before evaluating the signal', async () => {
    await expect(
      h.domain.teamTools.dismissSignal(
        { ...operator, member: 'dev-1' },
        { signalId: 'unknown', note: 'Note' },
      ),
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('project_manager_only'),
    });
  });

  it('rejects guest conversations even for the Operator', async () => {
    const session = await waitForSession(h.domain, { member: 'pm' });
    const guest = { ...session, id: 'ses_pm_guest', workItem: { type: 'general', with: 'guest' } as const };
    h.repos.sessions.insert(guest);
    await expect(
      h.domain.teamTools.dismissSignal(
        { ...operator, sessionId: guest.id },
        { signalId: 'unknown', note: 'Note' },
      ),
    ).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('project_manager_only') });
  });

  it('dismisses without an owner request and hides the record-only note from the DTO', async () => {
    const card = await h.domain.tasks.create('AR', { title: 'Parked' }, { kind: 'human', handle: 'owner' });
    h.repos.tasks.update(card.id, { stageId: 'ready', status: 'active' });
    await h.domain.operatorSignals.sweep('AR');
    const signal = h.repos.operatorSignals.list('AR').find((s) => s.kind === 'ready_waiting')!;
    h.repos.operatorSignals.delivered([signal.id], new Date().toISOString(), 'pm');
    expect(h.repos.operatorRequests.latest('AR', 1)).toEqual([]);
    await expect(
      h.domain.teamTools.dismissSignal(operator, { signalId: signal.id, note: 'Waits intentionally.' }),
    ).resolves.toEqual({ signalId: signal.id, state: 'dismissed' });
    expect(h.repos.operatorSignals.get(signal.id)?.decisionNote).toBe('Waits intentionally.');
    expect(h.domain.operatorSignals.channel('AR').signals[0]).not.toHaveProperty('decisionNote');
    expect(h.domain.operatorSignals.active('AR')).toEqual([]);
    expect(h.repos.operatorRequests.latest('AR', 1)).toEqual([]);
  });

  it('maps domain refusals with the existing tool error conversion', async () => {
    await expect(
      h.domain.teamTools.dismissSignal(operator, { signalId: 'unknown', note: 'Note' }),
    ).rejects.toMatchObject({ code: 'invalid', message: 'unknown signal in this project' });
    const idle = h.domain.operatorSignals.raise({ projectKey: 'AR', kind: 'idle', caseKey: 'idle:missing' });
    await expect(
      h.domain.teamTools.dismissSignal(operator, { signalId: idle.id, note: 'Note' }),
    ).rejects.toMatchObject({ code: 'invalid', message: 'the PM may not dismiss this signal kind' });
    const ready = h.domain.operatorSignals.raise({
      projectKey: 'AR',
      kind: 'ready_waiting',
      caseKey: 'ready_waiting:missing',
    });
    await expect(
      h.domain.teamTools.dismissSignal(operator, { signalId: ready.id, note: 'Note' }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: 'operator_signal_closed: the signal is no longer open',
    });
  });
});

describe('reassign_task and cancel_task (PM-1040)', () => {
  let h: DomainHarness;
  let pm: ToolContext;
  beforeEach(async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        const member = config.team.members.find((m) => m.handle === 'pm')!;
        if (member.kind === 'ai') member.onLeave = false;
      },
    });
    const { session } = await h.domain.sessions.ensureSession('AR', 'pm', { type: 'general' });
    pm = { projectKey: 'AR', member: 'pm', sessionId: session.id, taskKey: null };
  });
  afterEach(async () => {
    await h?.cleanup();
  });
  const timelineOf = (key: string, type: string) =>
    h.domain.timeline.list('AR', { taskKey: key }).filter((event) => event.type === type);

  it('lets the PM reassign a card with the reason on the timeline, in the PM name', async () => {
    const card = await h.domain.tasks.create('AR', { title: 'Card' }, OWNER_ACTOR);
    await expect(
      h.domain.teamTools.reassignTask(pm, { taskKey: card.key, assignee: 'dev-1', reason: 'Dev is free' }),
    ).resolves.toEqual({ task_key: card.key, assignee: 'dev-1', previous: null });
    expect(h.domain.tasks.get('AR', card.key).assignee).toBe('dev-1');
    expect(timelineOf(card.key, 'task_assigned')).toMatchObject([
      { actor: { kind: 'ai', handle: 'pm' }, data: { assignee: 'dev-1', note: 'Dev is free' } },
    ]);
  });

  it('lets the PM cancel a card with the reason on the timeline, in the PM name', async () => {
    const card = await h.domain.tasks.create('AR', { title: 'Card' }, OWNER_ACTOR);
    await expect(
      h.domain.teamTools.cancelTask(pm, { taskKey: card.key, reason: 'Obsolete' }),
    ).resolves.toEqual({ task_key: card.key, status: 'cancelled' });
    expect(timelineOf(card.key, 'task_updated')).toMatchObject([
      { actor: { kind: 'ai', handle: 'pm' }, data: { action: 'cancelled', reason: 'Obsolete' } },
    ]);
  });

  it('refuses a closed card and an unknown member through the existing checks', async () => {
    const card = await h.domain.tasks.create('AR', { title: 'Card' }, OWNER_ACTOR);
    await expect(
      h.domain.teamTools.reassignTask(pm, { taskKey: card.key, assignee: 'nobody', reason: 'Why' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('unknown member') });
    await h.domain.teamTools.cancelTask(pm, { taskKey: card.key, reason: 'Done with it' });
    await expect(
      h.domain.teamTools.cancelTask(pm, { taskKey: card.key, reason: 'Again' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('cancelled') });
  });

  it('refuses any other member at the tool', async () => {
    const card = await h.domain.tasks.create('AR', { title: 'Card' }, OWNER_ACTOR);
    const dev = { ...pm, member: 'dev-1' };
    for (const call of [
      h.domain.teamTools.reassignTask(dev, { taskKey: card.key, assignee: 'dev-1', reason: 'Mine' }),
      h.domain.teamTools.cancelTask(dev, { taskKey: card.key, reason: 'Mine' }),
    ])
      await expect(call).rejects.toMatchObject({ message: expect.stringContaining('project_manager_only') });
    expect(h.domain.tasks.get('AR', card.key)).toMatchObject({ assignee: null, status: 'active' });
  });

  it('keeps the service refusing another AI member, the PM through an integrator, and keeps the admin path', async () => {
    const card = await h.domain.tasks.create('AR', { title: 'Card' }, OWNER_ACTOR);
    const dev: Actor = { kind: 'ai', handle: 'dev-1' };
    const viaIntegrator: Actor = { kind: 'ai', handle: 'pm', via: 'integrator' };
    for (const actor of [dev, viaIntegrator]) {
      await expect(
        h.domain.tasks.update('AR', card.key, { assignee: 'dev-1', assigneeReason: 'Mine' }, actor),
      ).rejects.toMatchObject({ code: 'insufficient_access' });
      await expect(h.domain.tasks.cancel('AR', card.key, { reason: 'Mine' }, actor)).rejects.toMatchObject({
        code: 'insufficient_access',
      });
    }
    await h.domain.tasks.update('AR', card.key, { assignee: 'dev-1' }, OWNER_ACTOR);
    expect(h.domain.tasks.get('AR', card.key).assignee).toBe('dev-1');
    expect(timelineOf(card.key, 'task_assigned')).toMatchObject([{ data: { assignee: 'dev-1' } }]);
    await h.domain.tasks.cancel('AR', card.key, {}, OWNER_ACTOR);
    expect(h.domain.tasks.get('AR', card.key).status).toBe('cancelled');
  });
});
