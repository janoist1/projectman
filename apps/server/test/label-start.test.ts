import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * PM-236: the Start button on a card whose gate before the work stage lacks a label an AI member
 * sets (here `design-ok` on `ui` cards, set by the designer `des`) starts that member's session
 * first; the developer's start waits for the label, durably, and goes ahead by itself. Card AR-1
 * is a `ui` card in the queue stage `backlog`; the gate sits on `development`.
 */
describe('Start of a card that waits for a label an AI member sets', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const setup = (config: ProjectConfig) => {
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
    config.pipeline.labels.push(
      { id: 'ui', name: 'UI', setBy: 'anyone' },
      { id: 'hold', name: 'Hold', blocks: true, setBy: 'anyone' },
      { id: 'design-ok', name: 'Design ok', setBy: { duties: ['ux_design'] } },
    );
    config.pipeline.stages.find((stage) => stage.id === 'development')!.gate = {
      conditions: [{ type: 'has_label', label: 'design-ok', when: 'ui' }],
    };
  };
  const task = () => h.domain.tasks.get('AR', 'AR-1');
  const waiting = () => task().startWaiting;
  const storedKeys = () => h.repos.deferredStarts.list().map((record) => record.key);
  const members = () => h.domain.sessions.list('AR', { taskKey: 'AR-1' }).map((s) => s.member);
  const start = (opts: { startSetters?: boolean; assignee?: string } = { startSetters: true }) =>
    h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER, ...opts });
  const label = (change: { add?: string[]; remove?: string[] }, actor = aiActor('des')) =>
    h.domain.tasks.changeLabels('AR', 'AR-1', change, actor);

  async function prepare(labels: string[] = ['ui']) {
    h = await createDomainHarness({ persistent: true, adjust: setup });
    await h.domain.tasks.create('AR', { title: 'Screen', labels }, OWNER_ACTOR);
  }

  it('starts the setter, not the developer, and keeps the developer waiting', async () => {
    await prepare();
    const result = await start();

    expect(result.awaiting).toEqual({ labels: ['design-ok'], members: ['des'] });
    expect(result.session).toBeNull();
    expect(members()).toEqual(['des']);
    expect(task()).toMatchObject({ stageId: 'backlog', assignee: null });
    expect(waiting()).toMatchObject({ reason: 'label_missing', labels: ['design-ok'], member: 'des' });
    expect(storedKeys()).toEqual(['work-start:AR:AR-1']);
    // Nothing changes while the label is missing, whatever retries.
    const before = waiting();
    await h.domain.admission.retryDeferred();
    await flush();
    expect(waiting()).toEqual(before);
    expect(members()).toEqual(['des']);
    expect(task().assignee).toBeNull();
  });

  it('starts the developer by itself once the label is on the card', async () => {
    await prepare();
    await start();

    await label({ add: ['design-ok'] });

    await vi.waitFor(() => expect(task().assignee).toBe('dev-1'));
    expect(task().stageId).toBe('development');
    expect(waiting()).toBeUndefined();
    expect(storedKeys()).toEqual([]);
    expect(members().sort()).toEqual(['des', 'dev-1']);
    await h.domain.admission.retryDeferred();
    await flush();
    expect(members()).toHaveLength(2);
  });

  it('starts the developer the person chose', async () => {
    await prepare();
    await start({ startSetters: true, assignee: 'dev-2' });
    await label({ add: ['design-ok'] });
    await vi.waitFor(() => expect(task().assignee).toBe('dev-2'));
  });

  it('keeps the waiting card from being started twice by a second click', async () => {
    await prepare();
    await start();
    const before = waiting();
    await start();
    expect(waiting()).toEqual(before);
    expect(members()).toEqual(['des']);
    expect(storedKeys()).toEqual(['work-start:AR:AR-1']);
  });

  it('ends the wait when somebody else assigns the card', async () => {
    await prepare();
    await start();
    h.domain.tasks.assign('AR', 'AR-1', 'dev-2', OWNER_ACTOR);
    await h.domain.admission.retryDeferred();
    await label({ add: ['design-ok'] });
    await flush();
    expect(storedKeys()).toEqual([]);
    expect(waiting()).toBeUndefined();
    expect(task()).toMatchObject({ assignee: 'dev-2', stageId: 'backlog' });
    expect(members()).toEqual(['des']);
  });

  it('ends the wait when the card is cancelled', async () => {
    await prepare();
    await start();
    await h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
    await h.domain.admission.retryDeferred();
    await flush();
    expect(storedKeys()).toEqual([]);
    expect(waiting()).toBeUndefined();
    expect(members()).toEqual(['des']);
  });

  it('ends the wait when the card is moved elsewhere', async () => {
    await prepare();
    await start();
    // The gate is taken off, and a person moves the card on by hand.
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      delete draft.pipeline.stages.find((stage) => stage.id === 'development')!.gate;
      return 'No gate on development';
    });
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    await flush();
    expect(storedKeys()).toEqual([]);
    expect(waiting()).toBeUndefined();
    expect(task()).toMatchObject({ stageId: 'code_review', assignee: null });
    // The reviewer's hand-over started; no developer did.
    expect(members()).not.toContain('dev-1');
    expect(members()).not.toContain('dev-2');
  });

  it('starts the developer when the card stops being a ui card', async () => {
    await prepare();
    await start();
    await label({ remove: ['ui'] }, OWNER_ACTOR);
    await vi.waitFor(() => expect(task().assignee).toBe('dev-1'));
    expect(task().stageId).toBe('development');
    expect(storedKeys()).toEqual([]);
  });

  it('keeps the wait over a restart, and the developer starts once the label is on', async () => {
    await prepare();
    await start();
    const before = waiting();

    h = await restartDomainHarness(h);
    await vi.waitFor(() => expect(waiting()).toEqual(before));
    expect(storedKeys()).toEqual(['work-start:AR:AR-1']);
    expect(task().assignee).toBeNull();

    await label({ add: ['design-ok'] });
    await vi.waitFor(() => expect(task().assignee).toBe('dev-1'));
    expect(storedKeys()).toEqual([]);
  });

  it('starts as before a card that is not bound to the label', async () => {
    await prepare([]);
    const result = await start();
    expect(result.awaiting).toBeUndefined();
    expect(task()).toMatchObject({ assignee: 'dev-1', stageId: 'development' });
    expect(members()).toEqual(['dev-1']);
    expect(storedKeys()).toEqual([]);
  });

  it('refuses the start as before when nobody asked for the setters to start', async () => {
    await prepare();
    await expect(start({})).rejects.toMatchObject({ code: 'gate_blocked' });
    expect(members()).toEqual([]);
    expect(storedKeys()).toEqual([]);
    expect(task().assignee).toBeNull();
  });

  it('refuses the start as before when a blocking label also holds the card back', async () => {
    await prepare(['ui', 'hold']);
    await expect(start()).rejects.toMatchObject({ code: 'gate_blocked' });
    expect(members()).toEqual([]);
    expect(storedKeys()).toEqual([]);
  });

  it('refuses the start as before when no AI member sets the label', async () => {
    await prepare();
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      draft.pipeline.labels.find((l) => l.id === 'design-ok')!.setBy = { members: ['owner'] };
      return 'Only the owner sets design-ok';
    });
    await expect(start()).rejects.toThrow();
    expect(members()).toEqual([]);
    expect(storedKeys()).toEqual([]);
    expect(task()).toMatchObject({ stageId: 'backlog', assignee: null });
  });

  it('starts nothing when the setter cannot start (it is on leave)', async () => {
    await prepare();
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      const designer = draft.team.members.find((m) => m.handle === 'des');
      if (designer?.kind === 'ai') designer.onLeave = true;
      return 'Designer on leave';
    });
    await expect(start()).rejects.toMatchObject({ code: 'member_on_leave' });
    expect(members()).toEqual([]);
    expect(storedKeys()).toEqual([]);
  });
});
