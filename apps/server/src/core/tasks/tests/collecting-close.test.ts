import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import {
  createDomainHarness,
  OWNER_ACTOR,
  snapshotDomainHarness,
} from '../../../../test/helpers/domain-harness';
import type { DomainHarness } from '../../../../test/helpers/domain-harness';
import { makeRepoless } from '../../../../test/helpers/test-template';

const AT = '2026-10-14T10:00:00.000Z';

/** The closer runs in the background after the commit that caused it: let it finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 3000 });

describe('collecting card closes with its parts (PM-647)', () => {
  let h: DomainHarness | undefined;
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });

  /**
   * AR-1 is the collecting card. Its parts stand in the release stage, so that a person moving one to Done
   * enters only the Done stage; the card itself, moving to Done from the first stage, enters the code review
   * and merge stages on the way, whose gates it lacks.
   */
  async function setup(opts: { parentStage?: string; labels?: string[] } = {}) {
    h = await createDomainHarness({
      adjust(config: ProjectConfig) {
        makeRepoless(config);
      },
    });
    await h.domain.tasks.create(
      'AR',
      {
        title: 'Collecting card',
        ...(opts.parentStage ? { stageId: opts.parentStage, importedAt: AT } : {}),
        ...(opts.labels ? { labels: opts.labels } : {}),
      },
      OWNER_ACTOR,
    );
  }
  async function part(stageId = 'release') {
    return h!.domain.tasks.create(
      'AR',
      { title: 'A part', parentKey: 'AR-1', stageId, importedAt: AT },
      OWNER_ACTOR,
    );
  }
  const card = () => h!.domain.tasks.get('AR', 'AR-1');
  const moveToDone = (key: string) => h!.domain.tasks.moveToStage('AR', key, 'done', OWNER_ACTOR);
  const cancel = (key: string) => h!.domain.tasks.cancel('AR', key, {}, OWNER_ACTOR);
  const stageEvents = () =>
    h!.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((event) => event.type === 'task_stage_changed');

  it('closes the card when its last part goes to Done, and says so on the timeline', async () => {
    await setup();
    await part();
    await part();
    await moveToDone('AR-2');
    await settle();
    expect(card().status).toBe('active');
    await moveToDone('AR-3');
    await waitFor(() => expect(card().status).toBe('done'));
    expect(card().stageId).toBe('done');
    const [event] = stageEvents();
    expect(event?.actor.kind).toBe('system');
    expect(event?.data).toMatchObject({
      from: 'backlog',
      to: 'done',
      partsClosed: { done: ['AR-2', 'AR-3'], cancelled: [], trigger: 'AR-3' },
    });
  });

  it('recovers a collecting card whose parts were already done before startup', async () => {
    await setup();
    await part('done');
    await settle();
    expect(card().status).toBe('active');
    const snapshot = await snapshotDomainHarness(h!);
    h = undefined;
    h = await createDomainHarness({ snapshot });
    await waitFor(() => expect(card().status).toBe('done'));
    expect(stageEvents()).toHaveLength(1);
    expect(stageEvents()[0]?.data).toMatchObject({ partsClosed: { done: ['AR-2'], cancelled: [] } });
  });

  it('closes the card when one part is done and the other is cancelled', async () => {
    await setup();
    await part();
    await part();
    await moveToDone('AR-2');
    await cancel('AR-3');
    await waitFor(() => expect(card().status).toBe('done'));
    expect(stageEvents()[0]?.data).toMatchObject({
      partsClosed: { done: ['AR-2'], cancelled: ['AR-3'], trigger: 'AR-3' },
    });
  });

  it('leaves the card open when every part was cancelled', async () => {
    await setup();
    await part();
    await part();
    await cancel('AR-2');
    await cancel('AR-3');
    await settle();
    expect(card().status).toBe('active');
    expect(stageEvents()).toHaveLength(0);
  });

  it('leaves a card in the development stage to a person, who then moves it without the gates', async () => {
    await setup({ parentStage: 'development' });
    await part();
    await part('done');
    await moveToDone('AR-2');
    await settle();
    expect(card().stageId).toBe('development');
    await h!.domain.tasks.update('AR', 'AR-1', { stageId: 'done' }, OWNER_ACTOR);
    expect(card().status).toBe('done');
    const [event] = stageEvents();
    expect(event?.actor).toMatchObject({ kind: 'human', handle: 'owner' });
    expect(event?.data).toMatchObject({ partsClosed: { done: ['AR-2', 'AR-3'] } });
  });

  it('holds the card back while a blocking label is on it, and closes it when the label comes off', async () => {
    await setup({ labels: ['waiting'] });
    await part();
    await moveToDone('AR-2');
    await settle();
    expect(card().status).not.toBe('done');
    await h!.domain.tasks.update('AR', 'AR-1', { removeLabels: ['waiting'] }, OWNER_ACTOR);
    await waitFor(() => expect(card().status).toBe('done'));
    const closed = (stageEvents()[0]?.data as { partsClosed: object }).partsClosed;
    expect(closed).toMatchObject({ done: ['AR-2'] });
    expect(closed).not.toHaveProperty('trigger');
  });

  it('does not close again a card a person reopened', async () => {
    await setup();
    await part();
    await moveToDone('AR-2');
    await waitFor(() => expect(card().status).toBe('done'));
    await h!.domain.tasks.moveToStage('AR', 'AR-1', 'backlog', OWNER_ACTOR);
    expect(card().status).toBe('active');
    await h!.domain.tasks.update('AR', 'AR-1', { addLabels: ['merge-ok'] }, OWNER_ACTOR);
    await settle();
    const snapshot = await snapshotDomainHarness(h!);
    h = undefined;
    h = await createDomainHarness({ snapshot });
    await settle();
    expect(card().status).toBe('active');
    expect(card().stageId).toBe('backlog');
  });

  it('keeps the gates for a person moving a card that has an open part', async () => {
    await setup();
    await part();
    await part();
    await moveToDone('AR-2');
    await expect(moveToDone('AR-1')).rejects.toMatchObject({ code: 'gate_blocked' });
    expect(card().status).toBe('active');
  });

  it('closes the card once when two parts close in the same round', async () => {
    await setup();
    await part();
    await part();
    await Promise.all([moveToDone('AR-2'), moveToDone('AR-3')]);
    await waitFor(() => expect(card().status).toBe('done'));
    await settle();
    expect(stageEvents()).toHaveLength(1);
  });
});
