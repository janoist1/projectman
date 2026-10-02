import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/**
 * PM-248: a person's Start also holds the entry gate of the stage the card is in. Card AR-1 sits in
 * the queue stage `backlog` (here `ready`), whose gate asks `design-ok` of `ui` cards: a card that
 * got there before the gate existed, or got `ui` later, must not skip the designer.
 */
describe('Start of a card whose own stage gate is not met', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const setup = (config: ProjectConfig, setBy: ProjectConfig['pipeline']['labels'][number]['setBy']) => {
    config.team.limits.maxConcurrentAi = 10;
    for (const stage of config.pipeline.stages) if (stage.kind !== 'release') delete stage.gate;
    config.pipeline.stages = config.pipeline.stages.filter((stage) => stage.kind !== 'release');
    config.team.members.push({
      kind: 'ai',
      handle: 'des',
      displayName: 'Designer',
      role: 'designer',
      sponsor: 'owner',
    } as ProjectConfig['team']['members'][number]);
    // A label only people set needs a person who holds its duty.
    const owner = config.team.members.find((m) => m.handle === 'owner');
    if (owner?.kind === 'human') owner.roles.push('designer');
    config.pipeline.labels.push(
      { id: 'ui', name: 'UI', setBy: 'anyone' },
      { id: 'design-ok', name: 'Design ok', setBy },
    );
    config.pipeline.stages.find((stage) => stage.id === 'backlog')!.gate = {
      conditions: [{ type: 'has_label', label: 'design-ok', when: 'ui' }],
    };
  };
  const task = () => h.domain.tasks.get('AR', 'AR-1');
  const members = () => h.domain.sessions.list('AR', { taskKey: 'AR-1' }).map((s) => s.member);
  const start = () =>
    h.domain.taskStarts.start('AR', 'AR-1', {
      actor: OWNER_ACTOR,
      author: OWNER,
      startSetters: true,
    });

  async function prepare(labels: string[], setBy: Parameters<typeof setup>[1] = { duties: ['ux_design'] }) {
    h = await createDomainHarness({ persistent: true, adjust: (config) => setup(config, setBy) });
    await h.domain.tasks.create('AR', { title: 'Screen', labels }, OWNER_ACTOR);
  }

  it('starts the designer and keeps the developer waiting, then starts the developer on the label', async () => {
    await prepare(['ui']);
    const result = await start();

    expect(result.awaiting).toEqual({ labels: ['design-ok'], members: ['des'] });
    expect(members()).toEqual(['des']);
    expect(task()).toMatchObject({ stageId: 'backlog', assignee: null });

    await h.domain.tasks.changeLabels('AR', 'AR-1', { add: ['design-ok'] }, aiActor('des'));
    await vi.waitFor(() => expect(task().assignee).toBe('dev-1'));
    expect(task().stageId).toBe('development');
  });

  it('starts the developer at once when the label is on the card', async () => {
    await prepare(['ui']);
    await h.domain.tasks.changeLabels('AR', 'AR-1', { add: ['design-ok'] }, aiActor('des'));
    const result = await start();

    expect(result.awaiting).toBeUndefined();
    expect(task()).toMatchObject({ stageId: 'development', assignee: 'dev-1' });
    expect(members()).toEqual(['dev-1']);
  });

  it('starts the developer at once when the card is not a ui card', async () => {
    await prepare([]);
    await start();

    expect(task()).toMatchObject({ stageId: 'development', assignee: 'dev-1' });
    expect(members()).toEqual(['dev-1']);
  });

  it('refuses the start, naming the label, when only a person sets it', async () => {
    await prepare(['ui'], { members: ['owner'] });

    await expect(start()).rejects.toMatchObject({ code: 'gate_blocked' });
    expect(members()).toEqual([]);
    expect(task()).toMatchObject({ stageId: 'backlog', assignee: null });
  });

  it('refuses the start, naming the approval, when the label is one only people may set', async () => {
    await prepare(['ui'], { duties: ['ux_design'], humansOnly: true });

    await expect(start()).rejects.toMatchObject({
      code: 'gate_blocked',
      details: { approvals: [{ stageId: 'backlog', label: 'design-ok' }] },
    });
    expect(members()).toEqual([]);
    expect(task()).toMatchObject({ stageId: 'backlog', assignee: null });
  });

  it('does not gate a card sent back from review to the work stage', async () => {
    await prepare(['ui']);
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    expect(task()).toMatchObject({ stageId: 'development' });

    // A Start of a card past the entry gate's stage moves nothing, so no gate holds it.
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    const result = await start();
    expect(result.awaiting).toBeUndefined();
    expect(task()).toMatchObject({ stageId: 'code_review', assignee: 'dev-1' });
  });
});
