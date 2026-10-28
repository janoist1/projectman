import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamToolError } from '../src/contracts';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { as, historyHarness } from './helpers/history';
import { seedOperatorSession } from './helpers/operator-session';

/**
 * The private search statistics were for the Operator alone (PM-787). With no Operator (decision 66, PM-1076) no
 * member holds the tool, so every call is refused; the service keeps its own owner and admin check.
 */
describe('the private history search statistics tool', () => {
  let h: DomainHarness;

  beforeEach(async () => {
    h = await historyHarness({
      adjust(config) {
        const pm = config.team.members.find((member) => member.handle === 'pm');
        if (pm?.kind === 'ai') pm.onLeave = false;
      },
    });
    await h.domain.history.search('AR', as('dev-1'), { query: 'zebra stripes' });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('refuses the project manager in the owner’s conversation, and a developer', async () => {
    const session = seedOperatorSession(h, 'AR', { member: 'pm' });
    const pm = { projectKey: 'AR', member: 'pm', sessionId: session.id, taskKey: null };
    const dev = { projectKey: 'AR', member: 'dev-1', sessionId: 'ses_dev', taskKey: null };
    for (const ctx of [pm, dev]) {
      const err = await rejection(h.domain.teamTools.getHistorySearchStats(ctx, {}), TeamToolError);
      expect(err.code).toBe('forbidden');
      expect(err.message).toMatch(/^history_stats_forbidden:/);
    }
  });

  it('still lets the service show an owner their statistics', () => {
    const stats = h.domain.history.stats('AR', { handle: 'owner', access: 'owner' }, {});
    expect(stats.totalSearches).toBe(1);
  });
});
