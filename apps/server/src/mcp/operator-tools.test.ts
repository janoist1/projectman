import { describe, expect, it } from 'vitest';
import { TEAM_TOOLS, toolOutputText } from './tools';
import { createFakeTeamToolsHandler, devContext } from './testing';

describe('Operator MCP tools', () => {
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
    const todo = { what: 'Renew the certificate', where: 'Hosting panel', expected: 'The new expiry date' };
    const args = tool.inputSchema.parse({ item_id: 'inb_1', outcome: 'todo', note: 'Needs a login', todo });
    expect(JSON.parse(toolOutputText(await tool.run({ ctx: devContext, args, handler })))).toEqual({
      inboxItemId: 'inb_1',
      outcome: 'todo',
    });
    expect(handler.calls[0]).toMatchObject({
      method: 'screenQuestion',
      args: { itemId: 'inb_1', outcome: 'todo', note: 'Needs a login', todo },
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
