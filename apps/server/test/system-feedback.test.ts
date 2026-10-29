import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_FEEDBACK_NEW_PER_DAY } from '@projectman/shared';
import type { ProjectConfig, Session, SystemFeedbackItem } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { DomainError, humanActor } from '../src/kernel';
import { OperatorRequests } from '../src/services/operator';
import { OPERATOR_GUEST_TOOLS, OPERATOR_READ_TOOLS } from '../src/services/operator/requests';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';

const INPUT = {
  title: 'Cannot read a card from another project',
  what: 'The Operator needed the text of a card in another project and no tool gave it.',
  workaround: 'Asked the owner to paste the text.',
  fix: 'Let the Operator read a card of a project it has a grant for.',
};
const OWNER_USER = { id: 'usr_owner' };

let h: DomainHarness;
let now: Date;
const feedback = () => h.domain.systemFeedback;

function withDana(config: ProjectConfig): void {
  const pm = config.team.members.find((member) => member.handle === 'pm');
  if (pm?.kind === 'ai') pm.onLeave = false;
  config.team.members.push({
    kind: 'human',
    handle: 'dana',
    displayName: 'Dana Example',
    email: 'dana@example.test',
    access: 'developer',
    roles: [],
  });
}

beforeEach(async () => {
  now = new Date('2026-10-20T10:00:00Z');
  h = await createDomainHarness({ now: () => now, adjust: withDana });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
});

/** A conversation of the member with a person (none: the owner), with an open request from them. */
function conversation(handle?: string, member = 'pm', request = true): ToolContext {
  const at = new Date().toISOString();
  const id = `ses_${member}_${handle ?? 'owner'}`;
  const session: Session = {
    id,
    projectKey: 'AR',
    member,
    workItem: { type: 'general', ...(handle ? { with: handle } : {}) },
    claudeSessionId: '',
    cwd: h.workspace,
    branch: null,
    transcriptPath: null,
    state: 'working',
    activity: null,
    startedAt: at,
    lastActivityAt: at,
    endedAt: null,
    startCause: { kind: 'message', by: humanActor(handle ?? 'owner') },
  };
  h.repos.sessions.insert(session);
  h.repos.sessions.update(id, { startCause: session.startCause });
  if (request)
    new OperatorRequests({ ctx: h.domain.ctx }).open({
      projectKey: 'AR',
      sessionId: id,
      source: 'message',
      messageId: null,
      from: handle ?? 'owner',
      text: 'Do something',
    });
  return { projectKey: 'AR', member, sessionId: id, taskKey: null };
}

const record = (overrides: Partial<typeof INPUT> & { sameAs?: string } = {}) =>
  feedback().record('AR', 'pm', 'ses_1', { ...INPUT, ...overrides });
const setCardMode = async () => {
  await h.domain.projects.create(
    { key: 'BR', name: 'Target', workspacePath: h.workspace, templateId: 'test' },
    OWNER,
  );
  feedback().setForwarding({ mode: 'card', projectKey: 'BR' }, OWNER_USER);
};
const cardsIn = (projectKey: string) => h.domain.tasks.list(projectKey);
const code = async (promise: Promise<unknown>) => (await rejection(promise, DomainError)).code;

describe('recording system feedback (PM-479)', () => {
  it('stores a new item as new, with the first occurrence', async () => {
    const item = await record();
    expect(item).toMatchObject({
      projectKey: 'AR',
      title: INPUT.title,
      state: 'new',
      forwarded: null,
      dismissed: null,
      cardError: null,
    });
    expect(item.occurrences).toHaveLength(1);
    expect(feedback().summary()).toEqual({ newCount: 1 });
  });

  it('files the text filtered: no secret, path, member or e-mail address survives', async () => {
    const item = await record({
      what: `Failed with Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 in ${h.workspace}/web`,
      workaround: 'Wrote to dana@example.test and asked Dana Example.',
    });
    const stored = JSON.stringify([item.title, item.what, item.workaround, item.fix]);
    expect(stored).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(stored).not.toContain(h.workspace);
    expect(stored).not.toContain('dana@example.test');
    expect(stored).not.toContain('Dana Example');
    expect(item.counts).toMatchObject({ secret: expect.any(Number), path: expect.any(Number) });
    expect((item.counts.member ?? 0) + (item.counts.email ?? 0)).toBeGreaterThanOrEqual(2);
    // The stored row itself is filtered, not only the view.
    expect(JSON.stringify(h.repos.systemFeedback.get(item.id))).not.toContain('dana@example.test');
  });

  it('adds an occurrence for the same gap and keeps the state', async () => {
    const first = await record();
    feedback().dismiss(first.id, 'known', OWNER_USER);
    const again = await record({ sameAs: first.id });
    expect(again.id).toBe(first.id);
    expect(again.occurrences).toHaveLength(2);
    expect(again.state).toBe('dismissed');
  });

  it("refuses another project's item as the same gap, as if it did not exist", async () => {
    await setCardMode();
    h.repos.systemFeedback.insert({
      id: 'fb_foreign',
      projectKey: 'BR',
      title: 't',
      what: 'w',
      workaround: 'w',
      fix: 'f',
      createdAt: now.toISOString(),
      version: 'dev',
      sessionId: null,
    });
    expect(await code(record({ sameAs: 'fb_foreign' }))).toBe('not_found');
    expect(await code(record({ sameAs: 'fb_missing' }))).toBe('not_found');
  });

  it('allows ten new items in 24 hours per project and more after a day', async () => {
    for (let i = 0; i < SYSTEM_FEEDBACK_NEW_PER_DAY; i++) await record({ title: `Gap ${i}` });
    expect(await code(record({ title: 'One too many' }))).toBe('system_feedback_limit');
    // An occurrence of a known gap is no new item.
    const [known] = feedback().list({ access: 'manage' }).items;
    await expect(record({ sameAs: known!.id })).resolves.toBeDefined();
    now = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    await expect(record({ title: 'The next day' })).resolves.toBeDefined();
  });

  it('refuses empty and oversized text', async () => {
    expect(await code(record({ what: '   ' }))).toBe('invalid_request');
    expect(await code(record({ title: 'x'.repeat(10_000) }))).toBe('invalid_request');
  });
});

describe('forwarding as a card (PM-479)', () => {
  it('opens a filtered card in the chosen project and forwards the item at once', async () => {
    await setCardMode();
    const item = await record({ what: `Saw ${h.workspace} and dana@example.test` });
    expect(item.state).toBe('forwarded');
    expect(item.forwarded).toMatchObject({ kind: 'card', projectKey: 'BR', taskKey: 'BR-1' });
    const cards = cardsIn('BR');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ key: 'BR-1', title: INPUT.title });
    expect(cards[0]!.description).not.toContain(h.workspace);
    expect(cards[0]!.description).not.toContain('dana@example.test');
    // Nothing of the source project is named in the card.
    expect(JSON.stringify(cards[0])).not.toContain('AR-');
    expect(cardsIn('AR')).toHaveLength(0);
  });

  it('keeps the item new and stores a safe error when the card cannot be made', async () => {
    await setCardMode();
    vi.spyOn(h.domain.tasks, 'create').mockRejectedValueOnce(new Error(`disk full at ${h.workspace}`));
    const item = await record();
    // The real error is logged for the operator of the machine; the item carries only a safe message.
    expect(h.log.errors).toHaveLength(1);
    h.log.errors.splice(0);
    expect(item.state).toBe('new');
    expect(item.cardError).toMatchObject({ code: 'internal_error' });
    expect(JSON.stringify(item.cardError)).not.toContain(h.workspace);
    expect(cardsIn('BR')).toHaveLength(0);
    // The owner tries again and the error goes away.
    const retried = await feedback().openCard(item.id, OWNER_ACTOR, OWNER_USER.id);
    expect(retried).toMatchObject({ state: 'forwarded', cardError: null });
    expect(cardsIn('BR')).toHaveLength(1);
  });

  it('opens one card when two requests come at once', async () => {
    const item = await record();
    await setCardMode();
    const results = await Promise.allSettled([
      feedback().openCard(item.id, OWNER_ACTOR, OWNER_USER.id),
      feedback().openCard(item.id, OWNER_ACTOR, OWNER_USER.id),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(cardsIn('BR')).toHaveLength(1);
  });

  it('makes no card when the item was finished meanwhile', async () => {
    const item = await record();
    await setCardMode();
    const create = h.domain.tasks.create.bind(h.domain.tasks);
    vi.spyOn(h.domain.tasks, 'create').mockImplementationOnce(async (...args) => {
      feedback().dismiss(item.id, 'known', OWNER_USER);
      return create(...args);
    });
    expect(await code(feedback().openCard(item.id, OWNER_ACTOR, OWNER_USER.id))).toBe(
      'system_feedback_wrong_state',
    );
    expect(cardsIn('BR')).toHaveLength(0);
    expect(h.repos.systemFeedback.get(item.id)?.state).toBe('dismissed');
  });

  it('never opens a second card when a step after the commit fails', async () => {
    const item = await record();
    await setCardMode();
    const create = h.domain.tasks.create.bind(h.domain.tasks);
    vi.spyOn(h.domain.tasks, 'create').mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error('notification failed');
    });
    expect(await feedback().openCard(item.id, OWNER_ACTOR, OWNER_USER.id)).toMatchObject({
      state: 'forwarded',
    });
    expect(await code(feedback().openCard(item.id, OWNER_ACTOR, OWNER_USER.id))).toBe(
      'system_feedback_wrong_state',
    );
    expect(cardsIn('BR')).toHaveLength(1);
  });

  it.each(['manual', 'off'] as const)('opens no card in %s mode', async (mode) => {
    await h.domain.projects.create(
      { key: 'BR', name: 'Target', workspacePath: h.workspace, templateId: 'test' },
      OWNER,
    );
    feedback().setForwarding({ mode }, OWNER_USER);
    const item = await record();
    expect(item.state).toBe('new');
    expect(await code(feedback().openCard(item.id, OWNER_ACTOR, OWNER_USER.id))).toBe(
      'system_feedback_forwarding_mode',
    );
    expect(cardsIn('BR')).toHaveLength(0);
  });

  it('keeps the setting history and refuses a card mode without a project that exists', async () => {
    expect(feedback().forwardingView()).toMatchObject({ mode: 'manual', projectKey: null, history: [] });
    expect(
      await code(
        Promise.resolve().then(() =>
          feedback().setForwarding({ mode: 'card', projectKey: 'ZZ' }, OWNER_USER),
        ),
      ),
    ).toBe('not_found');
    await setCardMode();
    feedback().setForwarding({ mode: 'off' }, OWNER_USER);
    expect(
      feedback()
        .forwardingView()
        .history.map((change) => change.mode),
    ).toEqual(['off', 'card']);
  });
});

describe('forwarding by hand (PM-479)', () => {
  it('previews the filtered text and checks an edit again before it is prepared', async () => {
    const item = await record();
    const preview = await feedback().preview(item.id);
    expect(preview.repository).toBe('janoist1/projectman');
    expect(preview.body).toContain(INPUT.what);
    const edited = await feedback().prepare(item.id, {
      title: preview.title,
      body: `${preview.body}\nAsk dana@example.test`,
    });
    expect(edited).toMatchObject({ result: 'refiltered' });
    expect(JSON.stringify(edited)).not.toContain('dana@example.test');
    const ready = await feedback().prepare(item.id, { title: preview.title, body: preview.body });
    expect(ready).toMatchObject({ result: 'ready' });
    expect(
      (ready as { url: string }).url.startsWith('https://github.com/janoist1/projectman/issues/new'),
    ).toBe(true);
  });

  it('marks an item forwarded for good, keeping only the issue number of the address', async () => {
    const item = await record();
    await expect(
      Promise.resolve().then(() =>
        feedback().markForwarded(
          item.id,
          { issueUrl: 'https://evil.example/janoist1/projectman/issues/3' },
          OWNER_USER,
        ),
      ),
    ).rejects.toMatchObject({ code: 'system_feedback_issue_url' });
    const done = feedback().markForwarded(
      item.id,
      { issueUrl: 'https://github.com/janoist1/projectman/issues/12?token=abc#x' },
      OWNER_USER,
    );
    expect(done).toMatchObject({
      state: 'forwarded',
      forwarded: { kind: 'issue', url: 'https://github.com/janoist1/projectman/issues/12' },
    });
    expect(() => feedback().markForwarded(item.id, {}, OWNER_USER)).toThrow(DomainError);
    expect(() => feedback().restore(item.id)).toThrow(DomainError);
    expect(await code(feedback().preview(item.id))).toBe('system_feedback_wrong_state');
  });

  it('dismisses with a reason and restores a dismissed item only', async () => {
    const item = await record();
    expect(() => feedback().restore(item.id)).toThrow(DomainError);
    expect(feedback().dismiss(item.id, 'not a gap', OWNER_USER)).toMatchObject({
      state: 'dismissed',
      dismissed: { reason: 'not a gap' },
    });
    expect(() => feedback().dismiss(item.id, 'again', OWNER_USER)).toThrow(DomainError);
    expect(feedback().restore(item.id)).toMatchObject({ state: 'new', dismissed: null });
  });

  it('refuses a preview in card mode, where the card is the way out', async () => {
    const item = await record();
    await setCardMode();
    expect(await code(feedback().preview(item.id))).toBe('system_feedback_forwarding_mode');
  });
});

describe('nothing leaves the installation (PM-479)', () => {
  it('uses neither GitHub nor the network for any step', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const item = await record();
    await feedback().preview(item.id);
    await feedback().prepare(item.id, { title: 'a', body: 'b' });
    feedback().markForwarded(item.id, {}, OWNER_USER);
    expect(fetch).not.toHaveBeenCalled();
    expect(h.github.prs.size).toBe(0);
  });
});

describe('the project manager tools (PM-479)', () => {
  it('records a gap without an open request, and lists the project’s items', async () => {
    const ctx = conversation(undefined, 'pm', false);
    const made = await h.domain.teamTools.recordSystemFeedback(ctx, INPUT);
    expect(made).toMatchObject({ state: 'new', created: true, occurrences: 1 });
    const again = await h.domain.teamTools.recordSystemFeedback(ctx, { ...INPUT, sameAs: made.id });
    expect(again).toMatchObject({ id: made.id, created: false, occurrences: 2 });
    const list = await h.domain.teamTools.listSystemFeedback(ctx);
    expect(list.items).toEqual([
      expect.objectContaining({ id: made.id, state: 'new', title: INPUT.title, occurrences: 2 }),
    ]);
    // What the owner decided is not told to the project manager.
    expect(Object.keys(list.items[0]!).sort()).toEqual([
      'id',
      'last_seen_at',
      'occurrences',
      'state',
      'title',
    ]);
  });

  it('logs no request step: the gap is the project manager’s own bookkeeping', async () => {
    const ctx = conversation();
    await h.domain.teamTools.recordSystemFeedback(ctx, INPUT);
    const [open] = h.repos.operatorRequests.openOfSession(ctx.sessionId);
    expect(h.repos.operatorRequests.steps(open!.id)).toEqual([]);
  });

  it('is for the project manager only and refused in a guest conversation', async () => {
    const dev = conversation(undefined, 'dev-1', false);
    for (const call of [
      () => h.domain.teamTools.recordSystemFeedback(dev, INPUT),
      () => h.domain.teamTools.listSystemFeedback(dev),
    ])
      await expect(call()).rejects.toBeInstanceOf(TeamToolError);
    const guest = conversation('dana');
    await expect(h.domain.teamTools.recordSystemFeedback(guest, INPUT)).rejects.toThrow(
      'operator_owner_only',
    );
    expect(feedback().list({ access: 'manage' }).items).toHaveLength(0);
  });

  it('is a write outside the read and guest allowances', () => {
    expect(OPERATOR_READ_TOOLS.has('record_system_feedback')).toBe(false);
    expect(OPERATOR_READ_TOOLS.has('list_system_feedback')).toBe(true);
    expect(OPERATOR_GUEST_TOOLS.has('record_system_feedback')).toBe(false);
    expect(OPERATOR_GUEST_TOOLS.has('list_system_feedback')).toBe(false);
  });
});
