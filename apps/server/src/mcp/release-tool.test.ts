import { describe, expect, it, vi } from 'vitest';
import { OPERATOR_GUEST_TOOLS, OPERATOR_NEVER_TOOLS, OPERATOR_READ_TOOLS } from '../domain/operator-requests';
import { TEAM_TOOLS } from './tools';
import { createFakeTeamToolsHandler } from './testing';

describe('check_release', () => {
  const tool = TEAM_TOOLS.find((tool) => tool.name === 'check_release')!;
  const ctx = { projectKey: 'AR', member: 'operator', taskKey: null, sessionId: 'session-1' };

  it('only reads, and takes a full commit id only', () => {
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.inputSchema.safeParse({}).success).toBe(true);
    expect(tool.inputSchema.safeParse({ commit: 'a'.repeat(40) }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ commit: 'main' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ commit: 'a'.repeat(40), title: 'x' }).success).toBe(false);
  });

  it('is in the Operator’s read tools, and in no guest or forbidden list', () => {
    expect(OPERATOR_READ_TOOLS.has('check_release')).toBe(true);
    expect(OPERATOR_GUEST_TOOLS.has('check_release')).toBe(false);
    expect(OPERATOR_NEVER_TOOLS.has('check_release')).toBe(false);
    expect(OPERATOR_NEVER_TOOLS.has('propose_release')).toBe(true);
  });

  it('prints the candidate with the proposers and says nothing was recorded', async () => {
    const handler = createFakeTeamToolsHandler();
    const check = vi.spyOn(handler, 'checkRelease');
    const result = await tool.run({ ctx, handler, args: { commit: 'b'.repeat(40) } });
    expect(check).toHaveBeenCalledWith(ctx, { commit: 'b'.repeat(40) });
    expect(result).toContain('Release check passed: commit ' + 'b'.repeat(40));
    expect(result).toContain('1 cards (FAKE-1 A merged card)');
    expect(result).toContain('proposers: devops');
    expect(result).toMatch(/Nothing was recorded\.$/);
  });

  it('prints the refusal as the proposal would give it', async () => {
    const handler = createFakeTeamToolsHandler();
    vi.spyOn(handler, 'checkRelease').mockResolvedValue({
      candidate: null,
      refusal: { code: 'release_open', message: 'release rel_1 is proposed' },
      proposers: ['devops'],
    });
    const result = await tool.run({ ctx, handler, args: {} });
    expect(result).toContain('Release check: would be refused — release_open: release rel_1 is proposed.');
    expect(result).toMatch(/Nothing was recorded\.$/);
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
