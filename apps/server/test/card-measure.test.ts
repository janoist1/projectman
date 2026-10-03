import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClosedCardsMeasure, TaskDetail, routes } from '@projectman/shared';
import type { TokenUsage } from '@projectman/shared';
import { aiActor, humanActor, SYSTEM_ACTOR } from '../src/domain';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

/*
 * PM-222: the closed cards of a period with their review rounds, send-backs and weighted tokens per
 * model (the model from the sessions' usage rows), and the rounds on a card's detail.
 */

let h: AppHarness;
let now: Date;
const cookies: Record<string, string> = {};
const owner = humanActor('owner');
const get = (who: string, url: string) => inject(h.app, 'GET', url, cookies[who] ?? null);

const usage = (model: string, scope: TokenUsage['scope'], input: number, cacheRead = 0): TokenUsage => ({
  model,
  scope,
  input,
  output: 0,
  cacheRead,
  cacheWrite: 0,
});

beforeEach(async () => {
  now = new Date('2026-10-02T08:00:00.000Z');
  h = await createAppHarness({ now: () => now });
  cookies.owner = await setupOwner(h.app);
  await createProject(h, cookies.owner);
  cookies.developer = await addHumanAndLogin(h.app, { handle: 'robin', access: 'developer' });
  cookies.client = await addHumanAndLogin(h.app, { handle: 'cecil', access: 'client' });
});
afterEach(() => h.close());

const domain = () => h.app.projectman.domain;

/** A card that goes through two reviews (the first asks for changes) and one send-back, then closes. */
async function closedCard(title: string, closedAt: string, assignee: string | null = 'dev-1') {
  const { tasks } = domain();
  now = new Date('2026-09-30T08:00:00.000Z');
  const key = (await tasks.create('AR', { title }, owner)).key;
  if (assignee) await tasks.update('AR', key, { assignee }, owner);
  await tasks.moveToStage('AR', key, 'development', owner);
  await tasks.moveToStage('AR', key, 'code_review', aiActor('dev-1'));
  await tasks.changeLabels('AR', key, { add: ['code-review-changes'] }, aiActor('cr'), { comment: 'Fix it' });
  await tasks.moveToStage('AR', key, 'development', aiActor('cr'));
  await tasks.moveToStage('AR', key, 'code_review', aiActor('dev-1'));
  // The gates of the stages the move to done passes: the review, the merge and the release.
  await tasks.changeLabels('AR', key, { add: ['code-review-ok'] }, aiActor('cr'));
  await tasks.changeLabels('AR', key, { add: ['merge-ok', 'release-ok'] }, owner);
  await tasks.changeLabels('AR', key, { add: ['pr-merged'] }, SYSTEM_ACTOR);
  now = new Date(closedAt);
  // A card moved into development without an assignee is started and assigned (PM-119).
  if (!assignee) tasks.assign('AR', key, null, owner);
  await tasks.moveToStage('AR', key, 'done', owner);
  return key;
}

async function measure(key: string, member: string, entries: TokenUsage[]) {
  const { session } = await domain().sessions.ensureSession('AR', member, { type: 'task', taskKey: key });
  h.runner.emit({ type: 'usage', sessionId: session.id, entries });
  return session;
}

describe('closed cards comparison', () => {
  it('lists the cards closed in the period with rounds and weighted tokens per model', async () => {
    const first = await closedCard('Login page', '2026-10-01T10:00:00.000Z');
    // The implementer changed model on the way: both models are on the card's sessions.
    await measure(first, 'dev-1', [
      usage('claude-opus-5-5', 'main', 100, 1000),
      usage('claude-haiku-4-5', 'subagent', 50),
    ]);
    await measure(first, 'cr', [usage('claude-sonnet-5-5', 'main', 10)]);
    const second = await closedCard('Logout', '2026-10-02T07:00:00.000Z', 'dev-2');
    await measure(second, 'dev-2', [usage('claude-sonnet-5-5', 'main', 40)]);
    // Closed before the period, still open and cancelled cards are left out.
    await closedCard('Old', '2026-09-10T10:00:00.000Z');
    now = new Date('2026-10-02T08:00:00.000Z');
    await domain().tasks.create('AR', { title: 'Open' }, owner);
    const dropped = await domain().tasks.create('AR', { title: 'Dropped' }, owner);
    await domain().tasks.cancel('AR', dropped.key, {}, owner);

    const res = await get('owner', routes.closedCardsMeasure('AR'));
    expect(res.statusCode).toBe(200);
    const view = ClosedCardsMeasure.parse(res.json());
    expect(view).toMatchObject({ days: 14, since: '2026-09-18T08:00:00.000Z' });
    expect(view.cards.map((card) => card.taskKey)).toEqual([second, first]);
    const rounds = { reviewRounds: 2, changeRequests: 1, sendBacks: 1 };
    expect(view.cards[1]).toMatchObject({
      title: 'Login page',
      closedAt: '2026-10-01T10:00:00.000Z',
      implementer: 'dev-1',
      implementerModels: ['claude-opus-5-5'],
      // 100 + 1000 / 10 of opus, 50 of the subagent's haiku, 10 of the reviewer's sonnet.
      tokens: 260,
      byModel: [
        { model: 'claude-opus-5-5', tokens: 200 },
        { model: 'claude-haiku-4-5', tokens: 50 },
        { model: 'claude-sonnet-5-5', tokens: 10 },
      ],
      rounds,
      unmeasuredSessions: 0,
    });
    expect(view.cards[0]).toMatchObject({
      implementer: 'dev-2',
      implementerModels: ['claude-sonnet-5-5'],
      tokens: 40,
      rounds,
    });
  });

  it('takes the period from the query and says which sessions were not measured', async () => {
    const key = await closedCard('Login page', '2026-09-30T20:00:00.000Z', null);
    const session = await measure(key, 'dev-2', [usage('claude-opus-5-5', 'main', 5)]);
    const old = await measure(key, 'dev-1', []);
    h.app.projectman.repos.db.prepare('UPDATE sessions SET usage_since = NULL WHERE id = ?').run(old.id);
    expect(session.id).not.toBe(old.id);
    now = new Date('2026-10-02T08:00:00.000Z');

    const week = ClosedCardsMeasure.parse(
      (await get('owner', `${routes.closedCardsMeasure('AR')}?days=1`)).json(),
    );
    expect(week.cards).toEqual([]);
    const view = ClosedCardsMeasure.parse(
      (await get('owner', `${routes.closedCardsMeasure('AR')}?days=3`)).json(),
    );
    // No assignee: the member that used the most tokens carried it.
    expect(view.cards[0]).toMatchObject({ implementer: 'dev-2', tokens: 5, unmeasuredSessions: 1 });
    expect((await get('owner', `${routes.closedCardsMeasure('AR')}?days=0`)).statusCode).toBe(400);
  });

  it('is refused to a client and without a login, and open to the other members', async () => {
    expect((await get('client', routes.closedCardsMeasure('AR'))).statusCode).toBe(403);
    expect((await get('nobody', routes.closedCardsMeasure('AR'))).statusCode).toBe(401);
    expect((await get('developer', routes.closedCardsMeasure('AR'))).statusCode).toBe(200);
  });
});

describe('rounds on the card detail', () => {
  it('counts them from the whole timeline for members, and leaves them out for clients', async () => {
    const key = await closedCard('Login page', '2026-10-01T10:00:00.000Z');
    await domain().tasks.update('AR', key, { visibility: 'shared' }, owner);
    const rounds = { reviewRounds: 2, changeRequests: 1, designChangeRequests: 0, sendBacks: 1 };
    const detail = TaskDetail.parse((await get('owner', routes.task('AR', key))).json());
    expect(detail.rounds).toEqual(rounds);
    const seen = TaskDetail.parse((await get('client', routes.task('AR', key))).json());
    expect(seen).not.toHaveProperty('rounds');
  });
});
