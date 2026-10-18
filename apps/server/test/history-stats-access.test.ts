import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { waitFor } from '../src/runner/test-helpers';
import { OPERATOR_REQUEST_TTL_MS } from '../src/services/operator';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { flush, settle } from './helpers/fakes';
import { as, historyHarness } from './helpers/history';

const OWNER = { handle: 'owner', access: 'owner' } as const;

/**
 * Who may read the private search statistics (PM-787): only the Operator, in the conversation of a human owner or
 * admin, during that person's own open message or answer request, whose provenance is read again from the stored rows.
 */
describe('the private history search statistics through the Operator', () => {
  let h: DomainHarness;
  let clock: Date;
  const tools = () => h.domain.teamTools;

  beforeEach(async () => {
    clock = new Date('2026-10-18T10:00:00.000Z');
    h = await historyHarness({ now: () => clock });
    // Some searches to read statistics about; one of them finds nothing.
    h.domain.history.search('AR', as('dev-1'), { query: 'zebra stripes' });
    clock = new Date(clock.getTime() + 1000);
    h.domain.history.search('AR', as('admin'), { query: 'giraffe necks' });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.cleanup();
  });

  const conversationOf = (from: string): Session | undefined =>
    h.domain.sessions
      .list('AR', { member: 'operator' })
      .find(
        (s) =>
          s.workItem.type === 'general' &&
          (from === 'owner' ? s.workItem.with === undefined : s.workItem.with === from),
      );
  const toolOf = (from: string): ToolContext => ({
    projectKey: 'AR',
    member: 'operator',
    sessionId: conversationOf(from)!.id,
    taskKey: null,
  });
  const opened = (from: string) => h.repos.operatorRequests.openOfSession(conversationOf(from)!.id);

  /** A person writes to the Operator with their own login; resolves when the message is in the conversation. */
  async function say(from: string, text = 'Show me the search statistics') {
    const result = await h.domain.messaging.sendReporting(
      'AR',
      from,
      { to: ['operator'], text },
      { awaitWake: true },
    );
    await settle();
    await waitFor(
      () => {
        const session = conversationOf(from);
        return (
          session &&
          h.runner.started.some((spec) => spec.sessionId === session.id) &&
          h.repos.messages.get(result.message.id)?.deliveredAt &&
          opened(from).length > 0
        );
      },
      { what: `${from}’s message to reach the Operator conversation` },
    );
    return result;
  }

  const forbidden = async (ctx: ToolContext) => {
    const err = await rejection(tools().getHistorySearchStats(ctx, {}), TeamToolError);
    expect(err.code).toBe('forbidden');
    expect(err.message).toMatch(/^history_stats_forbidden:/);
    return err;
  };

  /** Changes one stored field of a row, as a forged provenance would have it. */
  const patchJson = (table: string, column: string, id: string, patch: Record<string, unknown>) => {
    const row = h.repos.db.prepare(`SELECT ${column} AS v FROM ${table} WHERE id = ?`).get(id) as {
      v: string | null;
    };
    const value = { ...(row.v ? JSON.parse(row.v) : {}), ...patch };
    h.repos.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(JSON.stringify(value), id);
  };

  describe('who is let in', () => {
    it('shows an owner their statistics during their own message request', async () => {
      await say('owner');
      const stats = await tools().getHistorySearchStats(toolOf('owner'), {});
      expect(stats.totalSearches).toBe(2);
      expect(stats.byMember.map((entry) => entry.member).sort()).toEqual(['admin', 'dev-1']);
      expect(stats.zeroResults.map((entry) => entry.query).sort()).toEqual([
        'giraffe necks',
        'zebra stripes',
      ]);
    });

    it('shows an admin theirs in the admin’s own conversation, and takes the period and the page size', async () => {
      await say('admin');
      const stats = await tools().getHistorySearchStats(toolOf('admin'), { limit: 1, member: 'dev-1' });
      expect(stats.totalSearches).toBe(1);
      expect(stats.zeroResults.map((entry) => entry.query)).toEqual(['zebra stripes']);
    });

    it('shows an owner theirs during their own answer request', async () => {
      await say('owner', 'Plan the sprint');
      const { inboxItemId } = await tools().askHuman(toolOf('owner'), {
        question: 'How much of the history do you want to see?',
        options: ['All', 'The last week'],
      });
      h.runner.setState(conversationOf('owner')!.id, 'idle');
      await vi.waitFor(() => expect(opened('owner')).toHaveLength(0));
      await h.domain.inbox.resolve('AR', inboxItemId, { optionId: 'option_1' }, OWNER);
      await flush();
      expect(opened('owner')).toHaveLength(1);
      expect(opened('owner')[0]).toMatchObject({ source: 'answer', inboxItemId, fromHandle: 'owner' });
      await expect(tools().getHistorySearchStats(toolOf('owner'), {})).resolves.toMatchObject({
        totalSearches: 2,
      });
    });
  });

  describe('who is not', () => {
    it.each(['dev', 'reader', 'acme'])('refuses %s in their own conversation', async (handle) => {
      await say(handle);
      await forbidden(toolOf(handle));
    });

    it('refuses an AI member and a session that has no request', async () => {
      await forbidden({ projectKey: 'AR', member: 'dev-1', sessionId: 'ses_dev', taskKey: null });
      await say('owner');
      await forbidden({ ...toolOf('owner'), sessionId: 'ses_somebody_else' });
      await forbidden({ ...toolOf('owner'), member: 'dev-1' });
    });

    it('refuses the owner’s conversation once the request has run out', async () => {
      await say('owner');
      const ctx = toolOf('owner');
      await expect(tools().getHistorySearchStats(ctx, {})).resolves.toBeTruthy();
      clock = new Date(clock.getTime() + OPERATOR_REQUEST_TTL_MS + 1000);
      await forbidden(ctx);
    });

    it('refuses the owner’s conversation once the request is over', async () => {
      await say('owner');
      const ctx = toolOf('owner');
      await expect(tools().getHistorySearchStats(ctx, {})).resolves.toBeTruthy();
      h.runner.setState(ctx.sessionId, 'idle');
      await vi.waitFor(() => expect(opened('owner')).toHaveLength(0));
      await forbidden(ctx);
    });

    it('refuses an admin who has left the team', async () => {
      await say('admin');
      const { config } = await h.configStore.load('AR');
      config.team.members = config.team.members.filter((member) => member.handle !== 'admin');
      await h.configStore.save('AR', config, {
        author: { name: 'Owner', email: 'owner@example.com' },
        message: 'admin left',
      });
      await h.domain.projects.syncFromStore();
      await forbidden(toolOf('admin'));
    });

    it('refuses a request whose message came through the integrator or is not a person’s plain message', async () => {
      const sent = await say('owner');
      const ctx = toolOf('owner');
      await expect(tools().getHistorySearchStats(ctx, {})).resolves.toBeTruthy();
      for (const patch of [
        { column: 'via', value: 'integrator' },
        { column: 'origin', value: JSON.stringify({ kind: 'signal', signalId: 'sig_1' }) },
        { column: 'from_handle', value: 'dev' },
        { column: 'to_handles', value: JSON.stringify(['dev-1']) },
      ]) {
        const column = patch.column;
        const before = h.repos.db
          .prepare(`SELECT ${column} AS v FROM team_messages WHERE id = ?`)
          .get(sent.message.id) as { v: unknown };
        h.repos.db
          .prepare(`UPDATE team_messages SET ${column} = ? WHERE id = ?`)
          .run(patch.value, sent.message.id);
        await forbidden(ctx);
        h.repos.db
          .prepare(`UPDATE team_messages SET ${column} = ? WHERE id = ?`)
          .run(before.v, sent.message.id);
        await expect(tools().getHistorySearchStats(ctx, {}), column).resolves.toBeTruthy();
      }
    });

    it('refuses a request that is only an approval or a signal, or has no message behind it', async () => {
      await say('owner');
      const ctx = toolOf('owner');
      const [real] = opened('owner');
      h.repos.operatorRequests.close(real!.id, clock.toISOString());
      for (const forged of [
        { source: 'approval' as const, messageId: real!.messageId },
        { source: 'signal' as const, messageId: real!.messageId },
        { source: 'message' as const, messageId: null },
        { source: 'message' as const, messageId: 'msg_does_not_exist' },
        { source: 'answer' as const, messageId: real!.messageId },
      ]) {
        const id = `opr_forged_${forged.source}_${forged.messageId ?? 'none'}`;
        h.repos.operatorRequests.insert({
          id,
          projectKey: 'AR',
          sessionId: ctx.sessionId,
          source: forged.source,
          messageId: forged.messageId,
          inboxItemId: null,
          fromHandle: 'owner',
          quote: 'Forged',
          openedAt: clock.toISOString(),
        });
        await forbidden(ctx);
        h.repos.operatorRequests.close(id, clock.toISOString());
      }
    });

    it('refuses an answer that was relayed, resolved through the integrator or by a rule', async () => {
      await say('owner', 'Plan the sprint');
      const { inboxItemId } = await tools().askHuman(toolOf('owner'), {
        question: 'How much of the history do you want to see?',
        options: ['All', 'The last week'],
      });
      h.runner.setState(conversationOf('owner')!.id, 'idle');
      await vi.waitFor(() => expect(opened('owner')).toHaveLength(0));
      await h.domain.inbox.resolve('AR', inboxItemId, { optionId: 'option_1' }, OWNER);
      await flush();
      const ctx = toolOf('owner');
      await expect(tools().getHistorySearchStats(ctx, {})).resolves.toBeTruthy();
      const original = h.repos.db
        .prepare('SELECT resolution FROM inbox_items WHERE id = ?')
        .get(inboxItemId) as {
        resolution: string;
      };
      for (const patch of [
        { via: 'integrator' },
        { ownerAnswerRelayed: { by: 'integrator', at: clock.toISOString() } },
        { rule: 'auto' },
        { by: 'dev' },
      ]) {
        patchJson('inbox_items', 'resolution', inboxItemId, patch);
        await forbidden(ctx);
        h.repos.db
          .prepare('UPDATE inbox_items SET resolution = ? WHERE id = ?')
          .run(original.resolution, inboxItemId);
        await expect(tools().getHistorySearchStats(ctx, {}), JSON.stringify(patch)).resolves.toBeTruthy();
      }
    });
  });

  describe('where the numbers and the search text do not go', () => {
    it('keeps them out of the history, the diagnostics, the timeline and the bus', async () => {
      const events: unknown[] = [];
      h.domain.bus.subscribe((event) => events.push(event));
      h.domain.history.search('AR', as('dev-1'), { query: 'platypus beak' });
      await say('owner');
      const stats = await tools().getHistorySearchStats(toolOf('owner'), {});
      expect(JSON.stringify(stats)).toContain('platypus beak');

      const task = await h.domain.tasks.create('AR', { title: 'A card' }, { kind: 'human', handle: 'owner' });
      h.domain.history.flush();
      const diagnostics = await tools().getOperatorDiagnostics(toolOf('owner'), { taskKey: task.key });
      const timeline = h.repos.db.prepare('SELECT * FROM timeline_events').all();
      const messages = h.repos.db.prepare('SELECT * FROM team_messages').all();
      const found = h.domain.history.search('AR', OWNER, { query: 'platypus' });
      const everything = JSON.stringify({ events, diagnostics, timeline, messages, found, log: h.log });
      for (const phrase of ['platypus', 'zebra stripes', 'giraffe necks'])
        expect(everything, phrase).not.toContain(phrase);
      expect(found.matches).toEqual([]);
    });
  });
});
