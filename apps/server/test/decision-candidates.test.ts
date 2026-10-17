import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem, ProjectConfig, Session } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { waitFor } from '../src/runner/test-helpers';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { flush } from './helpers/fakes';

let h: DomainHarness;
let now = new Date('2026-10-11T10:00:00.000Z');
afterEach(async () => {
  await h?.cleanup();
});

const SIGNAL =
  /(\d+) owner answers on cards since you last looked may be decisions: list_decision_candidates\./;

function adjusted(opts: { docs: boolean }) {
  return (config: ProjectConfig): void => {
    if (opts.docs) config.project.repos[0]!.docs = { decisions: 'docs/DECISIONS.md' };
    config.team.members.push({
      kind: 'human',
      handle: 'dana',
      displayName: 'Dana',
      email: 'dana@example.test',
      access: 'developer',
      roles: [],
    });
  };
}

async function setup(opts: { docs?: boolean } = {}): Promise<void> {
  now = new Date('2026-10-11T10:00:00.000Z');
  h = await createDomainHarness({ now: () => now, adjust: adjusted({ docs: opts.docs !== false }) });
  await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
}

let seq = 0;
/** An answered question; by default the owner's answer to dev-1 at the given time. */
function answered(
  id: string,
  at: string,
  extra: {
    source?: string;
    by?: string;
    rule?: 'approval_given';
    via?: 'integrator';
    taskKey?: string | null;
    optionId?: string;
    note?: string | null;
    title?: string;
    body?: string | null;
  } = {},
): string {
  seq += 1;
  const item: InboxItem = {
    id,
    projectKey: 'AR',
    kind: 'question',
    assignees: ['owner'],
    source: extra.source ?? 'dev-1',
    sessionId: null,
    taskKey: extra.taskKey === undefined ? 'AR-1' : extra.taskKey,
    title: extra.title ?? `Question ${seq}?`,
    body: extra.body === undefined ? null : extra.body,
    payload: {},
    options: [
      { id: 'option_1', label: 'Use SQLite', style: 'primary' },
      { id: 'option_2', label: 'Use files', style: 'secondary' },
    ],
    state: 'resolved',
    resolution: {
      optionId: extra.optionId ?? 'option_1',
      by: extra.by ?? 'owner',
      at,
      note: extra.note === undefined ? null : extra.note,
      ...(extra.rule ? { rule: extra.rule } : {}),
      ...(extra.via ? { via: extra.via } : {}),
    },
    createdAt: '2026-10-11T08:00:00.000Z',
  };
  h.repos.inbox.insert(item);
  return id;
}

const setSince = (since: string) =>
  h.repos.db
    .prepare(
      'INSERT OR REPLACE INTO decision_candidate_state (project_key, since, listed_at) VALUES (?, ?, NULL)',
    )
    .run('AR', since);

const config = () => h.domain.projects.config('AR');
const candidates = async (limit?: number) => h.domain.decisionCandidates.list('AR', await config(), limit);

async function ask(text: string, from = 'owner', to = 'operator') {
  const result = await h.domain.messaging.sendReporting('AR', from, { to: [to], text });
  // Delivery starts the session in the background; wait for this message, not event-loop turns.
  await vi.waitFor(() => {
    const conversation = sessions().filter(
      (s) => s.workItem.type === 'general' && s.workItem.with === (from === 'owner' ? undefined : from),
    );
    expect(conversation).toHaveLength(1);
    expect(h.repos.messages.pending('AR', to).map((message) => message.id)).not.toContain(result.message.id);
    if (from === 'owner') {
      expect(
        h.repos.operatorRequests.openOfSession(conversation[0]!.id).map((request) => request.messageId),
      ).toEqual([result.message.id]);
    }
  });
}
const sessions = (): Session[] => h.domain.sessions.list('AR', { member: 'operator' });
const ownerSession = (): Session =>
  sessions().find((s) => s.workItem.type === 'general' && s.workItem.with === undefined)!;
const toolOf = (session: Session): ToolContext => ({
  projectKey: 'AR',
  member: 'operator',
  sessionId: session.id,
  taskKey: null,
});
async function endTurn(): Promise<void> {
  // The fake runner does not report working when it receives another message.
  h.runner.setState(ownerSession().id, 'working');
  h.runner.setState(ownerSession().id, 'idle');
  await vi.waitFor(() => expect(h.repos.operatorRequests.openOfSession(ownerSession().id)).toHaveLength(0));
}
const requestOf = (session: Session) => h.repos.operatorRequests.openOfSession(session.id)[0]!;
const refusal = async (promise: Promise<unknown>) => (await rejection(promise, TeamToolError)).message;
const typedSince = (from: number) => h.runner.messages.slice(from).map((m) => m.text);

describe('the decision candidates (PM-496)', () => {
  it('lists the owner’s answers to others’ questions, the earliest answer first, with what the owner said', async () => {
    await setup();
    answered('inb_b', '2026-10-11T09:30:00.000Z', {
      note: 'Only for the new tables.',
      title: 'Which store?',
      body: 'We need a store.',
    });
    answered('inb_a', '2026-10-11T09:00:00.000Z', { via: 'integrator', optionId: 'option_2', taskKey: null });
    const { candidates: list, more } = await candidates();
    expect(more).toBe(false);
    expect(list.map((c) => c.item_id)).toEqual(['inb_a', 'inb_b']);
    expect(list[1]).toEqual({
      item_id: 'inb_b',
      task_key: 'AR-1',
      task_title: 'Login page',
      asked_by: 'dev-1',
      asked_at: '2026-10-11T08:00:00.000Z',
      question: 'Which store?\n\nWe need a store.',
      answer: { option: 'Use SQLite', note: 'Only for the new tables.' },
      answered_by: 'owner',
      answered_at: '2026-10-11T09:30:00.000Z',
      via_integrator: false,
    });
    expect(list[0]).toMatchObject({
      task_key: null,
      task_title: null,
      answer: { option: 'Use files', note: null },
      via_integrator: true,
    });
  });

  it('cuts the question at 2000 characters', async () => {
    await setup();
    answered('inb_long', '2026-10-11T09:00:00.000Z', { title: 'T', body: 'x'.repeat(5000) });
    expect((await candidates()).candidates[0]!.question).toHaveLength(2000);
  });

  it('leaves out other people’s answers, rule-closed questions, the Operator’s own and open ones', async () => {
    await setup();
    answered('inb_owner', '2026-10-11T09:00:00.000Z');
    answered('inb_dana', '2026-10-11T09:01:00.000Z', { by: 'dana' });
    answered('inb_rule', '2026-10-11T09:02:00.000Z', { rule: 'approval_given' });
    answered('inb_operator', '2026-10-11T09:03:00.000Z', { source: 'operator' });
    // An approval of a human's request and a still open question are no candidates either.
    const open = answered('inb_open', '2026-10-11T09:04:00.000Z');
    h.repos.db.prepare("UPDATE inbox_items SET state = 'open', resolution = NULL WHERE id = ?").run(open);
    const approval = answered('inb_approval', '2026-10-11T09:05:00.000Z');
    h.repos.db.prepare("UPDATE inbox_items SET kind = 'approval' WHERE id = ?").run(approval);
    expect((await candidates()).candidates.map((c) => c.item_id)).toEqual(['inb_owner']);
  });

  it('leaves out answers given before the project’s since, and a project with no row has no bound', async () => {
    await setup();
    answered('inb_old', '2026-10-11T09:00:00.000Z');
    answered('inb_new', '2026-10-11T09:45:00.000Z');
    expect((await candidates()).candidates.map((c) => c.item_id)).toEqual(['inb_old', 'inb_new']);
    setSince('2026-10-11T09:30:00.000Z');
    expect((await candidates()).candidates.map((c) => c.item_id)).toEqual(['inb_new']);
  });

  it('answers more when there are further candidates, and each call sets listed_at', async () => {
    await setup();
    for (const [i, id] of ['inb_1', 'inb_2', 'inb_3'].entries()) answered(id, `2026-10-11T09:0${i}:00.000Z`);
    expect(h.repos.decisionOffers.state('AR')).toBeNull();
    const first = await candidates(2);
    expect(first.candidates.map((c) => c.item_id)).toEqual(['inb_1', 'inb_2']);
    expect(first.more).toBe(true);
    expect(h.repos.decisionOffers.state('AR')).toEqual({ since: '', listedAt: now.toISOString() });
    now = new Date('2026-10-11T10:30:00.000Z');
    const rest = await candidates(3);
    expect(rest.more).toBe(false);
    expect(h.repos.decisionOffers.state('AR')?.listedAt).toBe('2026-10-11T10:30:00.000Z');
  });

  it('is refused with docs_not_configured when the project has no decision log', async () => {
    await setup({ docs: false });
    answered('inb_1', '2026-10-11T09:00:00.000Z');
    await expect(candidates()).rejects.toMatchObject({ code: 'docs_not_configured', status: 409 });
    expect(h.repos.decisionOffers.state('AR')).toBeNull();
  });
});

describe('mark_decision_candidates (PM-496)', () => {
  async function ownerAsks() {
    await ask('Look at the decisions');
    const session = ownerSession();
    return { session, ctx: toolOf(session), requestId: requestOf(session).id };
  }
  const mark = (
    ctx: ToolContext,
    items: Parameters<typeof h.domain.teamTools.markDecisionCandidates>[1]['items'],
  ) => h.domain.teamTools.markDecisionCandidates(ctx, { items });

  it('records the verdicts and the step, and a marked item is no candidate any more', async () => {
    await setup();
    answered('inb_1', '2026-10-11T09:00:00.000Z');
    answered('inb_2', '2026-10-11T09:01:00.000Z');
    answered('inb_3', '2026-10-11T09:02:00.000Z');
    const { ctx, requestId } = await ownerAsks();
    expect(
      await mark(ctx, [
        { item_id: 'inb_1', verdict: 'recorded', decision: '52' },
        { item_id: 'inb_2', verdict: 'declined' },
      ]),
    ).toEqual({ marked: 2 });
    expect(h.repos.decisionOffers.get('AR', 'inb_1')).toMatchObject({
      verdict: 'recorded',
      decision: '52',
      requestId,
      decidedAt: now.toISOString(),
    });
    expect(h.repos.decisionOffers.get('AR', 'inb_2')).toMatchObject({ verdict: 'declined', decision: null });
    expect(h.repos.operatorRequests.steps(requestId)).toEqual([
      expect.objectContaining({ action: 'decision_offer', status: 'done' }),
    ]);
    expect((await candidates()).candidates.map((c) => c.item_id)).toEqual(['inb_3']);
  });

  it('records all or nothing: one unknown or not-candidate item refuses the whole call', async () => {
    await setup();
    answered('inb_1', '2026-10-11T09:00:00.000Z');
    answered('inb_dana', '2026-10-11T09:01:00.000Z', { by: 'dana' });
    const { ctx, requestId } = await ownerAsks();
    for (const bad of ['inb_missing', 'inb_dana']) {
      const error = await rejection(
        mark(ctx, [
          { item_id: 'inb_1', verdict: 'declined' },
          { item_id: bad, verdict: 'skipped' },
        ]),
        TeamToolError,
      );
      expect(error.code).toBe('not_found');
      expect(error.message).toContain(bad);
    }
    expect(h.repos.decisionOffers.get('AR', 'inb_1')).toBeNull();
    expect(h.repos.operatorRequests.steps(requestId).map((s) => [s.action, s.status])).toEqual([
      ['decision_offer', 'refused'],
      ['decision_offer', 'refused'],
    ]);
  });

  it('overwrites an item that was marked before', async () => {
    await setup();
    answered('inb_1', '2026-10-11T09:00:00.000Z');
    const { ctx } = await ownerAsks();
    await mark(ctx, [{ item_id: 'inb_1', verdict: 'declined' }]);
    now = new Date('2026-10-11T10:10:00.000Z');
    await mark(ctx, [{ item_id: 'inb_1', verdict: 'recorded', decision: '53' }]);
    expect(h.repos.decisionOffers.get('AR', 'inb_1')).toMatchObject({
      verdict: 'recorded',
      decision: '53',
      decidedAt: '2026-10-11T10:10:00.000Z',
    });
  });

  it('refuses a decision number with a verdict other than recorded', async () => {
    await setup();
    answered('inb_1', '2026-10-11T09:00:00.000Z');
    const { ctx } = await ownerAsks();
    const error = await rejection(
      mark(ctx, [{ item_id: 'inb_1', verdict: 'declined', decision: '52' }]),
      TeamToolError,
    );
    expect(error.code).toBe('invalid');
    expect(h.repos.decisionOffers.get('AR', 'inb_1')).toBeNull();
  });

  it('is refused without an open request, in a guest conversation, and for anyone but the Operator', async () => {
    await setup();
    answered('inb_1', '2026-10-11T09:00:00.000Z');
    const { ctx } = await ownerAsks();
    const items = [{ item_id: 'inb_1', verdict: 'declined' as const }];
    await endTurn();
    expect(await refusal(mark(ctx, items))).toContain('operator_no_request');
    // Dana (no owner) talks with the Operator in a conversation of their own.
    await ask('What is going on?', 'dana');
    const guest = await waitFor(
      () => sessions().find((s) => s.workItem.type === 'general' && s.workItem.with === 'dana'),
      { what: 'the Operator conversation with dana' },
    );
    expect(await refusal(mark(toolOf(guest), items))).toContain('operator_owner_only');
    const dev = { ...ctx, member: 'dev-1' };
    expect(await refusal(mark(dev, items))).toContain('operator_only');
    expect(await refusal(h.domain.teamTools.listDecisionCandidates(dev, {}))).toContain('operator_only');
    expect(await refusal(h.domain.teamTools.listDecisionCandidates(toolOf(guest), {}))).toContain(
      'operator_owner_only',
    );
    expect(h.repos.decisionOffers.get('AR', 'inb_1')).toBeNull();
  });

  it('lists through the tool with no open request, as a reading tool', async () => {
    await setup();
    answered('inb_1', '2026-10-11T09:00:00.000Z');
    const { ctx } = await ownerAsks();
    await endTurn();
    const result = await h.domain.teamTools.listDecisionCandidates(ctx, { limit: 5 });
    expect(result.candidates.map((c) => c.item_id)).toEqual(['inb_1']);
  });
});

describe('the signal line in the Operator’s batch (PM-496)', () => {
  /** The owner's second message, after the answers came: what is typed into the Operator's session. */
  async function nextOwnerMessage(): Promise<string> {
    const typed = h.runner.messages.length;
    await ask('Anything new?');
    return typedSince(typed).join('\n\n');
  }
  async function firstTurn(): Promise<void> {
    await ask('Hello');
    await endTurn();
  }

  it('is added to the owner’s message when answers came after the Operator last looked', async () => {
    await setup();
    await firstTurn();
    answered('inb_1', '2026-10-11T10:00:01.000Z');
    answered('inb_2', '2026-10-11T10:00:02.000Z');
    answered('inb_dana', '2026-10-11T10:00:03.000Z', { by: 'dana' });
    const text = await nextOwnerMessage();
    expect(SIGNAL.exec(text)?.[1]).toBe('2');
    expect(text.trimEnd().endsWith('list_decision_candidates.')).toBe(true);
    expect(h.repos.messages.pending('AR', 'operator')).toHaveLength(0);
  });

  it('is gone after the Operator listed the candidates, and returns for newer answers', async () => {
    await setup();
    await firstTurn();
    answered('inb_1', '2026-10-11T10:00:01.000Z');
    await endTurn();
    expect(await nextOwnerMessage()).toMatch(SIGNAL);
    now = new Date('2026-10-11T10:05:00.000Z');
    await candidates();
    await endTurn();
    expect(await nextOwnerMessage()).not.toMatch(SIGNAL);
    answered('inb_2', '2026-10-11T10:06:00.000Z');
    await endTurn();
    const text = await nextOwnerMessage();
    expect(SIGNAL.exec(text)?.[1]).toBe('1');
  });

  it('counts only answers after the project’s since', async () => {
    await setup();
    await firstTurn();
    answered('inb_old', '2026-10-11T09:00:00.000Z');
    setSince('2026-10-11T09:30:00.000Z');
    expect(await nextOwnerMessage()).not.toMatch(SIGNAL);
  });

  it('is left out without docs, and in a guest conversation', async () => {
    await setup({ docs: false });
    await firstTurn();
    answered('inb_1', '2026-10-11T10:00:01.000Z');
    expect(await nextOwnerMessage()).not.toMatch(SIGNAL);
    await h.cleanup();

    await setup();
    answered('inb_1', '2026-10-11T10:00:01.000Z');
    await ask('Hello', 'dana');
    const guest = await waitFor(
      () => sessions().find((s) => s.workItem.type === 'general' && s.workItem.with === 'dana'),
      { what: 'the Operator conversation with dana' },
    );
    h.runner.setState(guest.id, 'idle');
    await flush();
    const typed = h.runner.messages.length;
    await ask('And now?', 'dana');
    expect(typedSince(typed).join('\n\n')).toContain('And now?');
    expect(typedSince(typed).join('\n\n')).not.toMatch(SIGNAL);
  });
});
