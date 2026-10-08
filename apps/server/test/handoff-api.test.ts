import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import { createAppHarness, createProject, inject, setupOwner, addHumanAndLogin } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import { settle } from './helpers/fakes';

/** PM-342 2/3: the card change answers with what it started, and a closed handoff can be read. */
describe('handoff API', () => {
  let h: AppHarness;
  let cookie: string;
  const domain = () => h.app.projectman.domain;

  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    h.runner.idleOnStart = true;
    await domain().tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    await domain().taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(1));
    await settle();
  });
  afterEach(async () => h.close());

  it('answers the assignee change with the handoff it started, and serves the closed handoff', async () => {
    const dev1 = h.app.projectman.domain.sessions.list('AR', { member: 'dev-1', taskKey: 'AR-1' })[0]!;
    h.runner.emit({ type: 'transcript_path', sessionId: dev1.id, path: `/tmp/${dev1.id}.jsonl` });
    h.runner.setState(dev1.id, 'working');

    const changed = await inject(h.app, 'PATCH', routes.task('AR', 'AR-1'), cookie, { assignee: 'dev-2' });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      key: 'AR-1',
      assignee: 'dev-2',
      handoffStart: { mode: 'live', from: 'dev-1' },
    });
    await vi.waitFor(() => expect(domain().tasks.get('AR', 'AR-1').handoff?.step).toBe('writing'));
    const open = domain().tasks.get('AR', 'AR-1').handoff!;

    // The card shows the open handoff; its record is for a closed one only.
    const detail = await inject(h.app, 'GET', routes.task('AR', 'AR-1'), cookie);
    expect(detail.json().task.handoff).toMatchObject({
      id: open.id,
      from: 'dev-1',
      to: 'dev-2',
      step: 'writing',
    });
    const early = await inject(h.app, 'GET', routes.taskHandoff('AR', 'AR-1', open.id), cookie);
    expect(early.statusCode).toBe(404);

    await domain().handoffs.recordNote(
      { projectKey: 'AR', member: 'dev-1', sessionId: dev1.id },
      'AR-1',
      'Form done; the API call is missing.',
    );
    h.runner.setState(dev1.id, 'idle');
    await vi.waitFor(() => expect(domain().tasks.get('AR', 'AR-1').handoff).toBeUndefined());

    const record = await inject(h.app, 'GET', routes.taskHandoff('AR', 'AR-1', open.id), cookie);
    expect(record.statusCode).toBe(200);
    expect(record.json()).toMatchObject({
      id: open.id,
      from: 'dev-1',
      to: 'dev-2',
      outcome: 'note',
      reason: 'manual',
      note: 'Form done; the API call is missing.',
      summary: null,
    });
    expect(domain().tasks.get('AR', 'AR-1').lastHandoff).toMatchObject({ id: open.id, outcome: 'note' });
  });

  it('does not find an unknown handoff, or one under another card', async () => {
    const missing = await inject(h.app, 'GET', routes.taskHandoff('AR', 'AR-1', 'hof_unknown'), cookie);
    expect(missing.statusCode).toBe(404);
    await domain().tasks.create('AR', { title: 'Other' }, OWNER_ACTOR);
    const other = await inject(h.app, 'GET', routes.taskHandoff('AR', 'AR-2', 'hof_unknown'), cookie);
    expect(other.statusCode).toBe(404);
    const noTask = await inject(h.app, 'GET', routes.taskHandoff('AR', 'AR-99', 'hof_unknown'), cookie);
    expect(noTask.statusCode).toBe(404);
  });

  it('leaves the handoff to developers and above, and answers without handoffStart when the assignee stays', async () => {
    const viewer = await addHumanAndLogin(h.app, { handle: 'viewer-human', access: 'viewer' });
    const refused = await inject(h.app, 'GET', routes.taskHandoff('AR', 'AR-1', 'hof_any'), viewer);
    expect(refused.statusCode).toBe(403);

    const changed = await inject(h.app, 'PATCH', routes.task('AR', 'AR-1'), cookie, {
      title: 'Checkout page',
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).not.toHaveProperty('handoffStart');
    expect(domain().tasks.get('AR', 'AR-1').handoff).toBeUndefined();
  });
});
