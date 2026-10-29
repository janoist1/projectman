import { describe, expect, it, vi } from 'vitest';
import type { ExternalToolContext, ExternalToolsHandler, ReleaseCheckResult } from '../contracts';
import { TEAM_TOOLS } from './tools';
import { EXTERNAL_TOOLS } from './super-operator/registry';
import { createFakeTeamToolsHandler } from './testing';

describe('check_release (the integrator`s)', () => {
  const tool = EXTERNAL_TOOLS.find((tool) => tool.name === 'check_release')!;
  const ctx = { projectKey: 'AR', requestId: 'req-1' } as ExternalToolContext;
  const run = (result: ReleaseCheckResult, args: { commit?: string } = {}) => {
    const checkRelease = vi.fn(async () => result);
    const handler = { checkRelease } as unknown as ExternalToolsHandler;
    if (tool.projectless) throw new Error('check_release belongs to a project');
    return { checkRelease, result: tool.run({ ctx, handler, args }) };
  };

  it('only reads, takes a full commit id only, and is no member`s tool', () => {
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.inputSchema.safeParse({ project_key: 'AR' }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ project_key: 'AR', commit: 'a'.repeat(40) }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ project_key: 'AR', commit: 'main' }).success).toBe(false);
    expect(TEAM_TOOLS.map((team) => team.name)).not.toContain('check_release');
  });

  it('prints the candidate with the proposers and says nothing was recorded', async () => {
    const { checkRelease, result } = run(
      {
        candidate: {
          commit: 'b'.repeat(40),
          baseCommit: null,
          tasks: [{ key: 'FAKE-1', title: 'A merged card' }],
        },
        refusal: null,
        proposers: ['devops'],
      },
      { commit: 'b'.repeat(40) },
    );
    const text = await result;
    expect(checkRelease).toHaveBeenCalledWith(ctx, { commit: 'b'.repeat(40) });
    expect(text).toContain('Release check passed: commit ' + 'b'.repeat(40));
    expect(text).toContain('1 cards (FAKE-1 A merged card)');
    expect(text).toContain('proposers: devops');
    expect(text).toMatch(/Nothing was recorded\.$/);
  });

  it('prints the refusal as the proposal would give it', async () => {
    const text = await run({
      candidate: null,
      refusal: { code: 'release_open', message: 'release rel_1 is proposed' },
      proposers: ['devops'],
    }).result;
    expect(text).toContain('Release check: would be refused — release_open: release rel_1 is proposed.');
    expect(text).toMatch(/Nothing was recorded\.$/);
  });
});

describe('propose_release', () => {
  const tool = TEAM_TOOLS.find((tool) => tool.name === 'propose_release')!;
  const ctx = { projectKey: 'AR', member: 'devops', taskKey: null, sessionId: 'session-1' };

  it('bounds the text and takes a full commit id only', () => {
    expect(tool.inputSchema.safeParse({ title: 'Release', summary: '- AR-1' }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ title: '', summary: 'x' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ title: 'x', summary: '' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ title: 'x', summary: 'y'.repeat(4001) }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ title: 'x'.repeat(201), summary: 'y' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ title: 'x', summary: 'y', commit: 'main' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ title: 'x', summary: 'y', commit: 'abc123' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ title: 'x', summary: 'y', commit: 'a'.repeat(40) }).success).toBe(
      true,
    );
    // The caller is who the session is: nobody proposes in another member's name.
    expect(tool.inputSchema.safeParse({ title: 'x', summary: 'y', member: 'owner' }).success).toBe(false);
  });

  it('hands the call to the domain with the caller and tells the session to end', async () => {
    const handler = createFakeTeamToolsHandler();
    const propose = vi.spyOn(handler, 'proposeRelease');
    const result = await tool.run({ ctx, handler, args: { title: 'Release', summary: '- AR-1 Card' } });
    expect(propose).toHaveBeenCalledWith(ctx, {
      title: 'Release',
      summary: '- AR-1 Card',
      commit: undefined,
      preview: false,
    });
    expect(result).toContain('releaseId=rel_fake');
    expect(result).toContain('taskKey=FAKE-2');
    expect(result).toContain('FAKE-1 A merged card');
    expect(result).toContain('End your turn');
  });

  it('lists the commit and the cards of a preview and says nothing was recorded', async () => {
    const handler = createFakeTeamToolsHandler();
    const result = await tool.run({
      ctx,
      handler,
      args: { title: 'Release', summary: 'x', preview: true, commit: 'b'.repeat(40) },
    });
    expect(result).toContain('nothing recorded');
    expect(result).toContain(`commit=${'b'.repeat(40)}`);
    expect(result).toContain('FAKE-1 A merged card');
    expect(result).not.toContain('releaseId');
    expect(result).not.toContain('End your turn');
  });
});
