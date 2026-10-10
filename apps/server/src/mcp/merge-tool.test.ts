import { describe, expect, it, vi } from 'vitest';
import { TEAM_TOOLS } from './tools';
import { createFakeTeamToolsHandler, sampleTaskDetail } from './testing';

describe('merge_task', () => {
  it('accepts only the card key and delegates the caller identity to the domain', async () => {
    const tool = TEAM_TOOLS.find((tool) => tool.name === 'merge_task')!;
    expect(tool.inputSchema.safeParse({ task_key: 'AR-21', merger: 'owner' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ task_key: 'AR-21', commit: 'override' }).success).toBe(false);
    const handler = createFakeTeamToolsHandler();
    const task = sampleTaskDetail().task;
    task.merge = {
      id: 'merge-1',
      repo: 'web',
      base: 'main',
      toStageId: 'done',
      merger: 'fe-1',
      requestedAt: 'now',
      state: 'queued',
      step: 'queued',
      landed: 'nowhere',
    };
    const start = vi.spyOn(handler, 'mergeTask').mockResolvedValue({ task });
    const ctx = { projectKey: 'AR', member: 'fe-1', taskKey: 'AR-21', sessionId: 'session-1' };
    const result = await tool.run({ ctx, handler, args: { task_key: 'AR-21' } });
    expect(start).toHaveBeenCalledWith(ctx, { taskKey: 'AR-21' });
    expect(result).toContain('queued');
    expect(result).toContain('merge-1');
  });
});
