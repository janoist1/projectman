import { describe, expect, it } from 'vitest';
import { TEAM_TOOLS } from './tools';
import { createFakeTeamToolsHandler, devContext } from './testing';

describe('Operator MCP tools', () => {
  it('validates and forwards the operation and title and returns the step result', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'operate')!;
    const handler = createFakeTeamToolsHandler();
    const args = tool.inputSchema.parse({
      title: '  Change the writer  ',
      operation: { op: 'member_update', handle: 'dev-1', changes: { model: 'sonnet', capacity: 2 } },
    });
    const result = JSON.parse(await tool.run({ ctx: devContext, args, handler }));
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

  it('maps start_task arguments to the shared start handler', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'start_task')!;
    const handler = createFakeTeamToolsHandler();
    const args = tool.inputSchema.parse({ task_key: 'AR-1', assignee: 'dev-1', despite_prerequisites: true });
    expect(JSON.parse(await tool.run({ ctx: devContext, args, handler }))).toEqual({
      task_key: 'AR-1',
      session_id: null,
      hired: null,
    });
    expect(handler.calls[0]).toMatchObject({
      method: 'startTask',
      ctx: devContext,
      args: { taskKey: 'AR-1', assignee: 'dev-1', despitePrerequisites: true },
    });
    expect(tool.inputSchema.safeParse({ task_key: 'invalid' }).success).toBe(false);
  });
});
