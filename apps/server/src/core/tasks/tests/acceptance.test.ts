import { afterEach, describe, expect, it } from 'vitest';
import { createDomainHarness, OWNER_ACTOR } from '../../../../test/helpers/domain-harness';
import type { DomainHarness } from '../../../../test/helpers/domain-harness';
import { makeRepoless } from '../../../../test/helpers/test-template';
import { aiActor } from '../../../kernel';

const DEV = aiActor('dev-1');
const REVIEWER = aiActor('cr');

describe('acceptance items (PM-1135)', () => {
  let h: DomainHarness | undefined;
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });

  /** AR-1 is assigned to dev-1 and stands in Development, with two acceptance items. */
  async function setup(items: string[] = ['It builds', 'It is documented']) {
    h = await createDomainHarness({
      adjust(config) {
        makeRepoless(config);
      },
    });
    await h.domain.tasks.create(
      'AR',
      { title: 'A card', ...(items.length ? { acceptance: items } : {}) },
      OWNER_ACTOR,
    );
    await h.domain.tasks.update('AR', 'AR-1', { assignee: 'dev-1', stageId: 'development' }, OWNER_ACTOR);
  }
  const card = (key = 'AR-1') => h!.domain.tasks.get('AR', key);
  const items = (key = 'AR-1') => h!.domain.tasks.detail('AR', key).acceptance ?? [];
  const mark = (itemId: string, evidence = 'commit abc123') => ({ op: 'done' as const, itemId, evidence });
  const update = (change: Parameters<DomainHarness['domain']['tasks']['update']>[2], actor = DEV) =>
    h!.domain.tasks.update('AR', 'AR-1', change, actor);

  it('holds the review gate while an item is open, and passes it when the last mark comes with the move', async () => {
    await setup();
    const [first, second] = items();
    expect(card().labels).toEqual(expect.arrayContaining(['acceptance-open', 'acceptance-unconfirmed']));
    await update({ acceptance: [mark(first!.id)] });
    await expect(update({ stageId: 'code_review' })).rejects.toMatchObject({ code: 'gate_blocked' });
    await update({ stageId: 'code_review', acceptance: [mark(second!.id)] });
    expect(card().stageId).toBe('code_review');
    expect(card().labels).not.toContain('acceptance-open');
    expect(card().labels).toContain('acceptance-unconfirmed');
  });

  it('lets only the owner of the current step confirm an item, which then clears the unconfirmed label', async () => {
    await setup(['It builds']);
    const [only] = items();
    await update({ stageId: 'code_review', acceptance: [mark(only!.id)] });
    await expect(update({ acceptance: [{ op: 'confirm', itemId: only!.id }] })).rejects.toMatchObject({
      code: 'acceptance_item_refused',
      details: { reason: 'not_confirmer' },
    });
    await h!.domain.tasks.update(
      'AR',
      'AR-1',
      { acceptance: [{ op: 'confirm', itemId: only!.id }] },
      REVIEWER,
    );
    expect(items()[0]).toMatchObject({ state: 'done', confirmedBy: 'cr' });
    expect(card().labels).not.toContain('acceptance-unconfirmed');
  });

  it('refuses a person confirming the work they marked or are assigned to', async () => {
    await setup(['It builds']);
    const [only] = items();
    await update({ acceptance: [mark(only!.id)] }, OWNER_ACTOR);
    await expect(
      update({ acceptance: [{ op: 'confirm', itemId: only!.id }] }, OWNER_ACTOR),
    ).rejects.toMatchObject({
      code: 'acceptance_item_refused',
      details: { reason: 'own_work' },
    });
  });

  it('moves an item to another card as an open copy, related to the first, with an event on both', async () => {
    await setup(['It builds']);
    await h!.domain.tasks.create('AR', { title: 'The next card' }, OWNER_ACTOR);
    const [only] = items();
    await update({ acceptance: [{ op: 'move', itemId: only!.id, taskKey: 'AR-2' }] });
    expect(items()[0]).toMatchObject({ state: 'moved', movedTo: 'AR-2' });
    expect(items('AR-2')[0]).toMatchObject({ state: 'open', origin: { taskKey: 'AR-1', itemId: only!.id } });
    expect(card('AR-2').labels).toContain('acceptance-open');
    expect(h!.domain.tasks.relationsOf('AR', 'AR-1').map((relation) => relation.key)).toContain('AR-2');
    const changed = (key: string) =>
      h!.domain.timeline
        .list('AR', { taskKey: key })
        .filter((event) => event.type === 'acceptance_item_changed');
    expect(changed('AR-1')).toHaveLength(2);
    expect(changed('AR-2')).toHaveLength(1);
  });

  it('leaves a card without items without the labels and without a gate to pass', async () => {
    await setup([]);
    expect(card().labels).toEqual([]);
    await update({ stageId: 'code_review' });
    expect(card().stageId).toBe('code_review');
  });
});
