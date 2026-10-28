import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_SEARCH_RETENTION_DAYS, HistorySearchResult } from '@projectman/shared';
import type { HistorySearchInput, Session } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { as, historyHarness } from './helpers/history';
import { seedOperatorSession } from './helpers/operator-session';

const DAY = 24 * 60 * 60 * 1000;

interface LogRow {
  id: string;
  at: string;
  member: string;
  project_key: string;
  via: string | null;
  query: string;
  filters: string;
  result_count: number | null;
  has_more: number | null;
  outcome: string;
  error_code: string | null;
}

describe('the history tools of a member (PM-787)', () => {
  let h: DomainHarness;
  let clock: Date;
  const tools = () => h.domain.teamTools;
  const dev: ToolContext = { projectKey: 'AR', member: 'dev-1', sessionId: 'ses_dev', taskKey: null };

  const search = (input: Partial<HistorySearchInput> & { query: string }, ctx = dev) =>
    tools().searchHistory(ctx, input);
  const rows = (): LogRow[] =>
    h.repos.db.prepare('SELECT * FROM history_searches ORDER BY at, id').all() as LogRow[];
  const card = async (title: string, extra: { description?: string } = {}) => {
    const created = await h.domain.tasks.create('AR', { title, ...extra }, OWNER_ACTOR);
    h.domain.history.flush();
    return created;
  };
  const refusal = (promise: Promise<unknown>) => rejection(promise, TeamToolError);
  const tick = (ms = 1000) => {
    clock = new Date(clock.getTime() + ms);
  };

  beforeEach(async () => {
    clock = new Date('2026-10-18T10:00:00.000Z');
    h = await historyHarness({ now: () => clock });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.cleanup();
  });

  describe('search_history and read_history_source', () => {
    it('searches the project of the session and returns the facade result as it is', async () => {
      await card('Checkout redesign', { description: 'The basket page' });
      const result = await search({ query: 'checkout' });
      expect(HistorySearchResult.parse(result)).toEqual(result);
      expect(result.projectKey).toBe('AR');
      expect(result.matches.map((match) => match.excerpt)).toEqual(['Checkout redesign The basket page']);
      expect(result).toEqual(await h.domain.history.search('AR', as('dev-1'), { query: 'checkout' }));
    });

    it('refuses another project, also for the same handle, and an unknown one the same way', async () => {
      await card('Checkout redesign');
      for (const projectKey of ['BR', 'ZZ']) {
        const err = await refusal(tools().searchHistory(dev, { query: 'checkout', projectKey }));
        expect(err.code).toBe('forbidden');
        expect(err.message).toMatch(/^insufficient_access:/);
        const read = await refusal(tools().readHistorySource(dev, { sourceId: 'msg_x', projectKey }));
        expect(read.message).toMatch(/^insufficient_access:/);
      }
      // The project's own key is no refusal.
      await expect(tools().searchHistory(dev, { query: 'checkout', projectKey: 'AR' })).resolves.toBeTruthy();
      expect(rows()).toHaveLength(1);
    });

    it('gives a member who is no AI member of the project no history', async () => {
      const err = await refusal(search({ query: 'checkout' }, { ...dev, member: 'admin' }));
      expect(err.code).toBe('forbidden');
      expect(rows()).toEqual([]);
    });

    it('answers a source the member may not read like one that does not exist', async () => {
      await h.domain.messaging.send(
        'AR',
        'owner',
        { to: ['admin'], text: 'The budget numbers of the audit', taskKey: null },
        { actor: OWNER_ACTOR },
      );
      h.domain.history.flush();
      const owner = await h.domain.history.search(
        'AR',
        { handle: 'owner', access: 'owner' },
        { query: 'budget' },
      );
      const sourceId = owner.matches[0]!.sourceId;
      // A third party's message is no hit for the AI member, and its id opens nothing.
      expect((await search({ query: 'budget' })).matches).toEqual([]);
      const hidden = await refusal(tools().readHistorySource(dev, { sourceId }));
      const missing = await refusal(tools().readHistorySource(dev, { sourceId: 'msg_does_not_exist' }));
      expect(hidden.code).toBe('not_found');
      expect(missing.code).toBe('not_found');
      expect(hidden.message.replace(sourceId, 'ID')).toBe(
        missing.message.replace('msg_does_not_exist', 'ID'),
      );
    });

    it('opens the message of a hit with the reference the hit names', async () => {
      await h.domain.messaging.send(
        'AR',
        'owner',
        { to: ['dev-1'], text: 'Use the staging mirror for the import', taskKey: null },
        { actor: OWNER_ACTOR },
      );
      h.domain.history.flush();
      const result = await search({ query: 'staging mirror' });
      expect(result.matches).toHaveLength(1);
      const hit = result.matches[0]!;
      expect(hit.reference).toEqual({
        tool: 'read_history_source',
        arguments: { project_key: 'AR', source_id: hit.sourceId },
      });
      const read = await tools().readHistorySource(dev, { sourceId: hit.sourceId });
      expect(read.projectKey).toBe('AR');
      expect(read.text).toContain('Use the staging mirror for the import');
      expect(read.sourceType).toBe('message');
    });

    it('refuses a commit on a source that is no document, and a bad search before any record', async () => {
      await h.domain.messaging.send(
        'AR',
        'owner',
        { to: ['dev-1'], text: 'Mirror the import', taskKey: null },
        { actor: OWNER_ACTOR },
      );
      h.domain.history.flush();
      const hit = (await search({ query: 'mirror' })).matches[0]!;
      const err = await refusal(
        tools().readHistorySource(dev, { sourceId: hit.sourceId, commit: 'a'.repeat(40) }),
      );
      expect(err.message).toMatch(/^invalid_request:/);
      const bad = await refusal(search({ query: '   ' }));
      expect(bad.code).toBe('invalid');
      expect(bad.message).toMatch(/^invalid_request:/);
      expect(rows()).toHaveLength(1);
    });
  });

  describe('the Operator in a guest’s conversation', () => {
    // The app starts no Operator session (PM-1045): the guest's conversation is seeded.
    const say = (from: string) => seedOperatorSession(h, 'AR', { with: from });
    const conversationWith = (handle: string): Session | undefined =>
      h.domain.sessions
        .list('AR', { member: 'operator' })
        .find((s) => s.workItem.type === 'general' && s.workItem.with === handle);
    const toolOf = (handle: string): ToolContext => ({
      projectKey: 'AR',
      member: 'operator',
      sessionId: conversationWith(handle)!.id,
      taskKey: null,
    });

    it('reads with the guest’s own view: a client finds every card like a viewer (PM-79)', async () => {
      await card('Shared page');
      await card('Internal page plan');
      say('acme');
      const found = await tools().searchHistory(toolOf('acme'), { query: 'page' });
      expect(found.matches).toHaveLength(2);
      // The record names the guest, not the Operator.
      expect(rows().map((row) => [row.member, row.via])).toEqual([['acme', null]]);
      expect(found).toEqual(await h.domain.history.search('AR', as('acme'), { query: 'page' }));
    });

    it('lets a guest who left the team find nothing and records nothing', async () => {
      await card('Shared page');
      say('acme');
      const { config } = await h.configStore.load('AR');
      config.team.members = config.team.members.filter((member) => member.handle !== 'acme');
      await h.configStore.save('AR', config, {
        author: { name: 'Owner', email: 'owner@example.com' },
        message: 'acme left',
      });
      await h.domain.projects.syncFromStore();
      const err = await refusal(tools().searchHistory(toolOf('acme'), { query: 'page' }));
      expect(err.message).toMatch(/^insufficient_access:/);
      const read = await refusal(tools().readHistorySource(toolOf('acme'), { sourceId: 'msg_x' }));
      expect(read.message).toMatch(/^insufficient_access:/);
      expect(rows()).toEqual([]);
    });

    it('does not let a guest pick another project either', async () => {
      say('acme');
      const err = await refusal(tools().searchHistory(toolOf('acme'), { query: 'page', projectKey: 'BR' }));
      expect(err.message).toMatch(/^insufficient_access:/);
    });
  });

  describe('the private measurement', () => {
    it('records one search once, with the member, the normalized filters and the number returned', async () => {
      await card('Checkout redesign');
      await card('Checkout copy');
      tick();
      await search({ query: 'checkout', limit: 1, sourceTypes: ['task'] });
      const [row] = rows();
      expect(rows()).toHaveLength(1);
      expect(row).toMatchObject({
        at: clock.toISOString(),
        member: 'dev-1',
        project_key: 'AR',
        via: null,
        query: 'checkout',
        result_count: 1,
        has_more: 1,
        outcome: 'ok',
        error_code: null,
      });
      expect(JSON.parse(row!.filters)).toEqual({ sourceTypes: ['task'], limit: 1 });
    });

    it('records a search without a result as a zero, and a defaulted search with its defaults', async () => {
      await search({ query: 'nothing matches this' });
      const [row] = rows();
      expect(row).toMatchObject({ result_count: 0, has_more: 0, outcome: 'ok' });
      expect(JSON.parse(row!.filters)).toEqual({
        sourceTypes: ['task', 'note', 'question', 'message', 'document'],
        limit: 10,
      });
    });

    it('records the same filters whichever door the search came from', async () => {
      await card('Checkout redesign');
      const input = {
        query: 'checkout',
        sourceTypes: ['note', 'task'] as ('note' | 'task')[],
        since: '2026-10-01T02:00:00+02:00',
        until: '2026-12-01T00:00:00Z',
        limit: 5,
      };
      await tools().searchHistory(dev, input);
      tick();
      await h.domain.history.search('AR', { handle: 'owner', access: 'owner', via: 'integrator' }, input);
      const [native, integrator] = rows();
      expect(integrator!.filters).toBe(native!.filters);
      expect(JSON.parse(native!.filters)).toEqual({
        sourceTypes: ['task', 'note'],
        since: '2026-10-01T00:00:00.000Z',
        until: '2026-12-01T00:00:00.000Z',
        limit: 5,
      });
      expect([native!.via, integrator!.via]).toEqual([null, 'integrator']);
    });

    it('leaves no record for a call that is not a search, and none for a read', async () => {
      await card('Checkout redesign');
      await refusal(search({ query: '   ' }));
      await refusal(search({ query: 'checkout', taskKey: 'AR-999' }));
      await refusal(tools().searchHistory(dev, { query: 'checkout', projectKey: 'BR' }));
      await expect(h.domain.history.search('AR', as('nobody'), { query: 'checkout' })).rejects.toThrow();
      await expect(
        h.domain.history.search('AR', as('dev-1'), { query: 'checkout', limit: 0 }),
      ).rejects.toThrow();
      await refusal(tools().readHistorySource(dev, { sourceId: 'msg_missing' }));
      expect(rows()).toEqual([]);
      await search({ query: 'checkout' });
      expect(rows()).toHaveLength(1);
      const hit = (await search({ query: 'checkout' })).matches[0]!;
      expect(rows()).toHaveLength(2);
      await tools()
        .readHistorySource(dev, { sourceId: hit.sourceId })
        .catch(() => undefined);
      expect(rows()).toHaveLength(2);
    });

    it('records an internal error as a failed search without counts, and the error still reaches the caller', async () => {
      await card('Checkout redesign');
      vi.spyOn(h.repos.history, 'scan').mockImplementation(() => {
        throw new Error('the index broke');
      });
      await expect(search({ query: 'checkout' })).rejects.toThrow('the index broke');
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        outcome: 'error',
        result_count: null,
        has_more: null,
        error_code: 'internal_error',
      });
    });

    it('returns no result when the record cannot be written', async () => {
      await card('Checkout redesign');
      vi.spyOn(h.repos.historySearches, 'insert').mockImplementationOnce(() => {
        throw new Error('disk full');
      });
      const err = await refusal(search({ query: 'checkout' }));
      expect(err.message).toMatch(/^history_unavailable:/);
      expect(rows()).toEqual([]);
      // The failure is logged without the query text.
      expect(JSON.stringify(h.log.errors)).not.toContain('checkout');
      h.log.errors.length = 0;
      await expect(search({ query: 'checkout' })).resolves.toBeTruthy();
      expect(rows()).toHaveLength(1);
    });

    it('keeps the search text out of the application log', async () => {
      await card('Checkout redesign');
      await search({ query: 'confidential phrase' });
      expect(JSON.stringify([h.log.errors, h.log.warnings])).not.toContain('confidential phrase');
    });
  });

  describe('retention', () => {
    const insert = (
      id: string,
      at: Date,
      extra: Partial<Parameters<DomainHarness['repos']['historySearches']['insert']>[0]> = {},
    ) =>
      h.repos.historySearches.insert({
        id,
        at: at.toISOString(),
        member: 'dev-1',
        projectKey: 'AR',
        via: null,
        query: id,
        filters: '{}',
        resultCount: 1,
        hasMore: false,
        outcome: 'ok',
        errorCode: null,
        semanticStatus: 'not_run',
        semanticDurationMs: null,
        ...extra,
      });
    const ids = () => rows().map((row) => row.id);
    const edge = () => new Date(clock.getTime() - HISTORY_SEARCH_RETENTION_DAYS * DAY);

    it('purges strictly older than 90 days before a statistics read', () => {
      insert('just_older', new Date(edge().getTime() - 1));
      insert('exactly_90_days', edge());
      insert('newer', new Date(edge().getTime() + 1));
      h.domain.history.stats('AR', { handle: 'owner', access: 'owner' }, {});
      expect(ids()).toEqual(['exactly_90_days', 'newer']);
      tick(1);
      h.domain.history.stats('AR', { handle: 'owner', access: 'owner' }, {});
      expect(ids()).toEqual(['newer']);
    });

    it('purges when the server starts, and says how far back the log reaches', async () => {
      await h.cleanup();
      h = await historyHarness({ now: () => clock, persistent: true });
      insert('old', new Date(edge().getTime() - DAY));
      insert('recent', new Date(clock.getTime() - DAY));
      h = await restartDomainHarness(h, { now: () => clock, persistent: true });
      expect(ids()).toEqual(['recent']);
      const stats = h.domain.history.stats('AR', { handle: 'owner', access: 'owner' }, {});
      expect(stats.retainedSince).toBe(edge().toISOString());
    });
  });

  describe('the statistics', () => {
    const owner = { handle: 'owner', access: 'owner' } as const;
    const stats = (input: Parameters<DomainHarness['domain']['history']['stats']>[2] = {}) =>
      h.domain.history.stats('AR', owner, input);

    it('is empty for a period without searches, with a rate of zero', () => {
      expect(stats()).toMatchObject({
        totalSearches: 0,
        failedSearches: 0,
        byMember: [],
        zeroResultCount: 0,
        zeroResultRate: 0,
        zeroResults: [],
        nextCursor: null,
      });
    });

    it('defaults to the last 30 days up to now', () => {
      const result = stats();
      expect(result.until).toBe(clock.toISOString());
      expect(result.since).toBe(new Date(clock.getTime() - 30 * DAY).toISOString());
    });

    it('counts per member, leaves a failed search out of the rates, and lists the zero results newest first', async () => {
      await card('Checkout redesign');
      const as1 = async (query: string, viewer = 'dev-1') => {
        tick();
        await h.domain.history.search('AR', as(viewer), { query });
      };
      await as1('checkout');
      await as1('no such thing one');
      await as1('checkout');
      await as1('no such thing two', 'admin');
      await as1('checkout', 'admin');
      tick();
      vi.spyOn(h.repos.history, 'scan').mockImplementationOnce(() => {
        throw new Error('broke');
      });
      await expect(h.domain.history.search('AR', as('dev-1'), { query: 'checkout' })).rejects.toThrow(
        'broke',
      );

      const result = stats();
      expect(result.totalSearches).toBe(5);
      expect(result.failedSearches).toBe(1);
      expect(result.byMember).toEqual([
        { member: 'dev-1', searches: 3, zeroResultSearches: 1 },
        { member: 'admin', searches: 2, zeroResultSearches: 1 },
      ]);
      expect(result.zeroResultCount).toBe(2);
      expect(result.zeroResultRate).toBeCloseTo(0.4);
      expect(result.zeroResults.map((entry) => [entry.member, entry.query])).toEqual([
        ['admin', 'no such thing two'],
        ['dev-1', 'no such thing one'],
      ]);
      expect(result.zeroResults[0]!.filters).toMatchObject({ limit: 10 });
      expect(result.nextCursor).toBeNull();
    });

    it('pages the zero results with a cursor and keeps the aggregate whole on every page', async () => {
      for (const query of ['zero a', 'zero b', 'zero c']) {
        tick();
        await h.domain.history.search('AR', as('dev-1'), { query });
      }
      const first = stats({ limit: 2 });
      expect(first.zeroResults.map((entry) => entry.query)).toEqual(['zero c', 'zero b']);
      expect(first.nextCursor).not.toBeNull();
      const second = stats({ limit: 2, cursor: first.nextCursor! });
      expect(second.zeroResults.map((entry) => entry.query)).toEqual(['zero a']);
      expect(second.nextCursor).toBeNull();
      for (const page of [first, second]) {
        expect(page).toMatchObject({ totalSearches: 3, zeroResultCount: 3, zeroResultRate: 1 });
      }
    });

    it('bounds the period by since and until, and one member by the member filter', async () => {
      const start = clock.toISOString();
      await h.domain.history.search('AR', as('dev-1'), { query: 'zero a' });
      tick(DAY);
      await h.domain.history.search('AR', as('admin'), { query: 'zero b' });
      tick(DAY);
      await h.domain.history.search('AR', as('dev-1'), { query: 'zero c' });
      expect(stats({ since: start, until: start }).totalSearches).toBe(1);
      expect(stats({ member: 'admin' })).toMatchObject({
        totalSearches: 1,
        byMember: [{ member: 'admin', searches: 1, zeroResultSearches: 1 }],
      });
      expect(() => stats({ since: clock.toISOString(), until: start })).toThrow();
    });

    it('refuses everyone but a current human owner or admin', () => {
      for (const handle of ['dev', 'reader', 'acme', 'dev-1', 'nobody'])
        expect(() => h.domain.history.stats('AR', as(handle), {}), handle).toThrow();
      expect(() => h.domain.history.stats('AR', as('admin'), {})).not.toThrow();
      expect(() =>
        h.domain.history.stats('AR', { handle: 'owner', access: 'owner', via: 'integrator' }, {}),
      ).toThrow();
    });
  });
});
