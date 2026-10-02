import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerEvent } from '@projectman/shared';
import type { ProjectConfig, Task } from '@projectman/shared';
import { conflict } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/** PM-119: a card moved into a work stage without an assignee starts like the Start button starts it. */
describe('automatic start of unassigned cards moved into a work stage', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const by = () => ({ actor: OWNER_ACTOR, author: OWNER });
  const create = async (title = 'Fictional feature') =>
    (await h.domain.tasks.create('AR', { title }, OWNER_ACTOR)).key;
  const move = (key: string, stage = 'development') =>
    h.domain.tasks.moveToStage('AR', key, stage, OWNER_ACTOR);
  const task = (key: string) => h.domain.tasks.get('AR', key);
  const waiting = (key: string) => task(key).startWaiting;
  const setLeave = (handle: string, leave: boolean) =>
    h.domain.members.update('AR', handle, { onLeave: leave }, by());
  const sessionsOf = (key: string) => h.domain.sessions.list('AR', { taskKey: key });
  const storedKeys = () => h.repos.deferredStarts.list().map((r) => r.key);
  /** Room for every session, so that the developers' capacity is what decides. */
  const roomy = (c: ProjectConfig) => void (c.team.limits.maxConcurrentAi = 10);
  const temp = (c: ProjectConfig) => {
    roomy(c);
    c.team.limits.tempWorkers = { enabled: true, max: 1, role: 'developer' };
  };
  const aiOff = async (aiEnabled: boolean) =>
    h.domain.projects.update('AR', by(), (draft) => {
      draft.team.limits.aiEnabled = aiEnabled;
      return 'Switch AI work';
    });

  it('starts a free developer on the moved card, as the Start button would', async () => {
    h = await createDomainHarness({ adjust: roomy });
    const key = await create();
    await move(key);
    await vi.waitFor(() => expect(task(key).assignee).toBe('dev-1'));
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(1));
    expect(sessionsOf(key)).toMatchObject([{ member: 'dev-1', workItem: { type: 'task', taskKey: key } }]);
    expect(waiting(key)).toBeUndefined();
    expect(storedKeys()).toEqual([]);
  });

  it('picks the free developer each time: a busy one and one on leave are skipped', async () => {
    h = await createDomainHarness({ adjust: temp });
    const first = await create('One');
    await move(first);
    await vi.waitFor(() => expect(task(first).assignee).toBe('dev-1'));
    const second = await create('Two');
    await move(second);
    await vi.waitFor(() => expect(task(second).assignee).toBe('dev-2'));
    expect(h.runner.started).toHaveLength(2);
  });

  it('leaves a developer on leave out, and waits with a clear status when nobody is free', async () => {
    h = await createDomainHarness({ adjust: roomy });
    await setLeave('dev-1', true);
    const first = await create('One');
    await move(first);
    await vi.waitFor(() => expect(task(first).assignee).toBe('dev-2'));

    // dev-2 is busy and dev-1 is away: the next card waits, durably.
    const second = await create('Two');
    await move(second);
    await vi.waitFor(() => expect(waiting(second)).toMatchObject({ reason: 'no_free_member' }));
    expect(waiting(second)?.member).toBeUndefined();
    expect(task(second).assignee).toBeNull();
    expect(storedKeys()).toEqual(['work-start:AR:AR-2']);
    expect(h.runner.started).toHaveLength(1);

    // Calling the developer back frees a place: the card starts without anyone asking.
    await setLeave('dev-1', false);
    await vi.waitFor(() => expect(task(second).assignee).toBe('dev-1'));
    expect(waiting(second)).toBeUndefined();
    expect(storedKeys()).toEqual([]);
    expect(h.runner.started).toHaveLength(2);
  });

  it('chooses a newly hired developer for a card without an assignee, and not a retired one (PM-133)', async () => {
    h = await createDomainHarness({ adjust: roomy });
    await setLeave('dev-1', true);
    await setLeave('dev-2', true);
    const hired = await h.domain.members.hire('AR', { role: 'developer' }, { ...by(), sponsor: 'owner' });
    const owners = async () =>
      (await h.domain.projects.config('AR')).pipeline.stages.find((s) => s.id === 'development')?.owners;
    expect(await owners()).toEqual(['dev-1', 'dev-2', hired.handle]);
    // Another role does not join the developers' stage.
    const qa = await h.domain.members.hire('AR', { role: 'qa' }, { ...by(), sponsor: 'owner' });
    expect(await owners()).not.toContain(qa.handle);

    const key = await create();
    await move(key);
    await vi.waitFor(() => expect(task(key).assignee).toBe(hired.handle));
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(1));

    await h.domain.members.retire('AR', hired.handle, {}, by());
    expect(await owners()).toEqual(['dev-1', 'dev-2']);
  });

  it('publishes the wait on the card (REST view and task_upserted), and its end', async () => {
    h = await createDomainHarness({ adjust: roomy });
    await setLeave('dev-1', true);
    await setLeave('dev-2', true);
    const snapshots: Task[] = [];
    h.domain.bus.subscribe((event) => {
      const parsed = ServerEvent.parse(event);
      if (parsed.type === 'task_upserted') snapshots.push(parsed.task);
    });
    const key = await create();
    await move(key);
    await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'no_free_member' }));
    expect(h.domain.tasks.list('AR').find((t) => t.key === key)?.startWaiting).toEqual(waiting(key));
    expect(snapshots.at(-1)).toMatchObject({ key, startWaiting: { reason: 'no_free_member' } });
    await setLeave('dev-1', false);
    await vi.waitFor(() => expect(snapshots.at(-1)).toMatchObject({ key, assignee: 'dev-1' }));
    expect(snapshots.at(-1)?.startWaiting).toBeUndefined();
  });

  it('waits when everyone is on leave, and starts once somebody is called back', async () => {
    h = await createDomainHarness({ adjust: roomy });
    await setLeave('dev-1', true);
    await setLeave('dev-2', true);
    const key = await create();
    await move(key);
    await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'no_free_member' }));
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(0);
    await setLeave('dev-2', false);
    await vi.waitFor(() => expect(task(key).assignee).toBe('dev-2'));
  });

  it('starts only as many cards as there is free capacity, and the next one when a card is handed on', async () => {
    h = await createDomainHarness({ adjust: roomy });
    const keys = [await create('One'), await create('Two'), await create('Three'), await create('Four')];
    for (const key of keys) await move(key);
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(2));
    await flush();
    expect(h.runner.started).toHaveLength(2);
    expect(keys.map((k) => task(k).assignee)).toEqual(['dev-1', 'dev-2', null, null]);
    expect(keys.map((k) => waiting(k)?.reason)).toEqual([
      undefined,
      undefined,
      'no_free_member',
      'no_free_member',
    ]);

    // The developer hands its card on, still finishing its turn: no capacity yet.
    const first = sessionsOf(keys[0]!)[0]!;
    h.runner.setState(first.id, 'working');
    await h.domain.tasks.moveToStage('AR', keys[0]!, 'code_review', { kind: 'ai', handle: 'dev-1' });
    await flush();
    expect(task(keys[2]!).assignee).toBeNull();
    // Its turn ends: capacity frees, and the card that waited longest starts.
    h.runner.setState(first.id, 'idle');
    await vi.waitFor(() => expect(task(keys[2]!).assignee).toBe('dev-1'));
    expect(task(keys[3]!).assignee).toBeNull();
    expect(waiting(keys[3]!)).toMatchObject({ reason: 'no_free_member' });
  });

  it('frees capacity for the waiting card when a session ends', async () => {
    h = await createDomainHarness({ adjust: roomy });
    const keys = [await create('One'), await create('Two'), await create('Three')];
    for (const key of keys) await move(key);
    await vi.waitFor(() => expect(waiting(keys[2]!)).toMatchObject({ reason: 'no_free_member' }));
    const running = sessionsOf(keys[0]!)[0]!;
    await h.domain.tasks.cancel('AR', keys[0]!, { reason: 'Fictional scope changed.' }, OWNER_ACTOR);
    await vi.waitFor(() => expect(task(keys[2]!).assignee).toBe(running.member));
  });

  it('hires a temp worker when the limits allow, and waits when they do not', async () => {
    h = await createDomainHarness({ adjust: temp });
    const keys = [await create('One'), await create('Two'), await create('Three'), await create('Four')];
    for (const key of keys) await move(key);
    await vi.waitFor(() => expect(task(keys[2]!).assignee).toBe('dev-3'));
    expect(
      (await h.domain.projects.config('AR')).team.members.find((m) => m.handle === 'dev-3'),
    ).toMatchObject({
      temp: true,
    });
    // Only one temp worker is allowed: the fourth waits.
    await vi.waitFor(() => expect(waiting(keys[3]!)).toMatchObject({ reason: 'no_free_member' }));
    expect(task(keys[3]!).assignee).toBeNull();
  });

  it('leaves a card that has an assignee alone: it is only told, as before', async () => {
    h = await createDomainHarness({ adjust: roomy });
    const key = await create();
    await h.domain.tasks.update('AR', key, { assignee: 'dev-2' }, OWNER_ACTOR);
    await move(key);
    await flush();
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(0);
    expect(task(key).assignee).toBe('dev-2');
    expect(storedKeys()).toEqual([]);

    // With a live session, the assignee is told that the card entered its stage.
    await h.domain.sessions.ensureSession('AR', 'dev-2', { type: 'task', taskKey: key });
    await move(key, 'backlog');
    await move(key);
    await vi.waitFor(() =>
      expect(h.runner.messages.some((m) => m.text.includes(`Task ${key} is now in stage Development`))).toBe(
        true,
      ),
    );
    expect(h.runner.started).toHaveLength(1);
  });

  it('creates no start while AI work is off, and does not start the card when it is switched back on', async () => {
    h = await createDomainHarness({ adjust: roomy });
    await aiOff(false);
    const key = await create();
    await move(key);
    await flush();
    expect(storedKeys()).toEqual([]);
    expect(waiting(key)).toBeUndefined();
    await aiOff(true);
    await flush();
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(0);
    expect(task(key).assignee).toBeNull();
    // Moving it again now starts it.
    await move(key, 'backlog');
    await move(key);
    await vi.waitFor(() => expect(task(key).assignee).toBe('dev-1'));
  });

  it('keeps a wait that began while AI was on when it is switched off and on again', async () => {
    h = await createDomainHarness({ adjust: roomy });
    await setLeave('dev-1', true);
    await setLeave('dev-2', true);
    const key = await create();
    await move(key);
    await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'no_free_member' }));
    await aiOff(false);
    await setLeave('dev-1', false);
    await h.domain.admission.retryDeferred();
    await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'ai_disabled' }));
    expect(h.runner.started).toHaveLength(0);
    await aiOff(true);
    await vi.waitFor(() => expect(task(key).assignee).toBe('dev-1'));
  });

  it('shows a missing repository on the card instead of waiting for it', async () => {
    h = await createDomainHarness({
      adjust: (c) =>
        void c.project.repos.push({ name: 'api', path: 'api', github: 'acme/api', defaultBranch: 'main' }),
    });
    const key = await create();
    await move(key);
    await flush();
    expect(h.runner.started).toHaveLength(0);
    expect(storedKeys()).toEqual([]);
    expect(waiting(key)).toMatchObject({ reason: 'repo_required' });
    expect(task(key).assignee).toBeNull();
    // A person's choice clears the status; nothing retries by itself.
    await h.domain.tasks.update('AR', key, { repo: 'web' }, OWNER_ACTOR);
    expect(waiting(key)).toBeUndefined();
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(0);
  });

  it('ends the wait when the card moves on, is cancelled or is assigned by someone', async () => {
    h = await createDomainHarness({ adjust: roomy });
    const busy = [await create('Busy one'), await create('Busy two')];
    for (const key of busy) await move(key);
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(2));
    const waits = [await create('One'), await create('Two'), await create('Three'), await create('Four')];
    for (const key of waits) await move(key);
    await vi.waitFor(() => expect(storedKeys()).toHaveLength(4));

    await move(waits[0]!, 'backlog');
    await h.domain.tasks.cancel('AR', waits[1]!, { reason: 'Fictional scope changed.' }, OWNER_ACTOR);
    await h.domain.tasks.update('AR', waits[2]!, { assignee: 'dev-2' }, OWNER_ACTOR);
    expect(waiting(waits[2]!)).toBeUndefined();
    // What the move and the cancellation made obsolete is gone; the assigned card's wait is dropped by the next retry.
    expect(storedKeys().sort()).toEqual(['work-start:AR:AR-5', 'work-start:AR:AR-6']);

    // A developer frees up: only the card still waiting starts; the assigned one is not touched.
    await h.domain.tasks.cancel('AR', busy[0]!, { reason: 'Fictional scope changed.' }, OWNER_ACTOR);
    await vi.waitFor(() => expect(task(waits[3]!).assignee).toBe('dev-1'));
    expect(h.runner.started).toHaveLength(3);
    expect(storedKeys()).toEqual([]);
    expect(sessionsOf(waits[0]!)).toEqual([]);
    expect(sessionsOf(waits[2]!)).toEqual([]);
    expect(task(waits[2]!).assignee).toBe('dev-2');
  });

  it('starts one session for a repeated move event and for a simultaneous Start', async () => {
    h = await createDomainHarness({ adjust: roomy });
    const key = await create();
    await move(key);
    const change = { task: task(key), from: 'backlog', to: 'development', actor: OWNER_ACTOR };
    await Promise.all([
      h.domain.workStarts.begin(change),
      h.domain.workStarts.begin(change),
      h.domain.taskStarts.start('AR', key, { assignee: 'dev-1', ...by() }),
    ]);
    await flush();
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(1);
    expect(sessionsOf(key)).toHaveLength(1);
    expect(task(key).assignee).toBe('dev-1');
  });

  it('carries on with its own half-done attempt, but not with an assignment somebody else made', async () => {
    h = await createDomainHarness({ adjust: roomy });
    const ensure = h.domain.sessions.ensureSession.bind(h.domain.sessions);
    let failures = 1;
    vi.spyOn(h.domain.sessions, 'ensureSession').mockImplementation(async (...args) => {
      if (failures-- > 0) throw conflict('workspace_dirty', 'the workspace holds unfinished work');
      return ensure(...args);
    });
    const key = await create();
    await move(key);
    // The attempt assigned the developer, then the session could not start: it waits for that very member.
    await vi.waitFor(() =>
      expect(waiting(key)).toMatchObject({ reason: 'workspace_dirty', member: 'dev-1' }),
    );
    expect(task(key).assignee).toBe('dev-1');
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(1);
    expect(sessionsOf(key)[0]!.member).toBe('dev-1');
    expect(waiting(key)).toBeUndefined();

    // The same wait, but somebody else assigns the card meanwhile: nothing starts for it.
    failures = 1;
    const other = await create('Other');
    await move(other);
    await vi.waitFor(() => expect(waiting(other)).toMatchObject({ reason: 'workspace_dirty' }));
    const owner = task(other).assignee!;
    const rest = owner === 'dev-1' ? 'dev-2' : 'dev-1';
    await h.domain.tasks.update('AR', other, { assignee: rest }, OWNER_ACTOR);
    await h.domain.admission.retryDeferred();
    expect(sessionsOf(other)).toEqual([]);
    expect(storedKeys()).toEqual([]);
  });

  it('keeps the wait and the same status across a server restart, then starts the card when one is free', async () => {
    h = await createDomainHarness({ persistent: true, adjust: roomy });
    await setLeave('dev-1', true);
    await setLeave('dev-2', true);
    const key = await create();
    await move(key);
    await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'no_free_member' }));
    const before = waiting(key);
    // Cards that merely sit in the work stage are not inferred into starts.
    const idle = await create('Imported');
    h.repos.tasks.update(task(idle).id, { stageId: 'development' });

    h = await restartDomainHarness(h);
    // The restored start is retried at once: while it is, the card does not show it.
    await vi.waitFor(() => expect(waiting(key)).toEqual(before));
    expect(storedKeys()).toEqual(['work-start:AR:AR-1']);
    expect(waiting(idle)).toBeUndefined();
    expect(h.runner.started).toHaveLength(0);

    await setLeave('dev-1', false);
    await vi.waitFor(() => expect(task(key).assignee).toBe('dev-1'));
    expect(task(idle).assignee).toBeNull();
    expect(h.runner.started).toHaveLength(1);
    expect(storedKeys()).toEqual([]);
  });

  it('starts again a card moved out and back into the stage after its wait was dropped', async () => {
    h = await createDomainHarness({ adjust: roomy });
    await setLeave('dev-1', true);
    await setLeave('dev-2', true);
    const key = await create();
    await move(key);
    await vi.waitFor(() => expect(storedKeys()).toEqual(['work-start:AR:AR-1']));
    await move(key, 'backlog');
    expect(storedKeys()).toEqual([]);
    expect(waiting(key)).toBeUndefined();

    await move(key);
    await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'no_free_member' }));
    expect(storedKeys()).toEqual(['work-start:AR:AR-1']);
    await setLeave('dev-1', false);
    await vi.waitFor(() => expect(task(key).assignee).toBe('dev-1'));
    expect(h.runner.started).toHaveLength(1);
  });

  it('starts again a card that was assigned by hand, unassigned and moved back in', async () => {
    h = await createDomainHarness({ adjust: roomy });
    await setLeave('dev-1', true);
    await setLeave('dev-2', true);
    const key = await create();
    await move(key);
    await vi.waitFor(() => expect(storedKeys()).toHaveLength(1));
    await h.domain.tasks.update('AR', key, { assignee: 'owner' }, OWNER_ACTOR);
    await h.domain.admission.retryDeferred();
    expect(storedKeys()).toEqual([]);
    await h.domain.tasks.update('AR', key, { assignee: null }, OWNER_ACTOR);
    await move(key, 'backlog');
    await move(key);
    await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'no_free_member' }));
    await setLeave('dev-2', false);
    await vi.waitFor(() => expect(task(key).assignee).toBe('dev-2'));
  });

  it('does not take for its own an assignment somebody made while its admission check ran', async () => {
    h = await createDomainHarness({ adjust: roomy });
    const check = h.domain.admission.check.bind(h.domain.admission);
    let taken = false;
    vi.spyOn(h.domain.admission, 'check').mockImplementation(async (request) => {
      if (!taken) {
        taken = true;
        // Not under the admission lock, like the REST assignment.
        h.domain.tasks.assign('AR', 'AR-1', 'dev-2', OWNER_ACTOR);
        throw conflict('member_at_capacity', 'fictional refusal');
      }
      return check(request);
    });
    const key = await create();
    await move(key);
    await vi.waitFor(() => expect(task(key).assignee).toBe('dev-2'));
    await flush();
    await h.domain.admission.retryDeferred();
    expect(sessionsOf(key)).toEqual([]);
    expect(storedKeys()).toEqual([]);
    expect(waiting(key)).toBeUndefined();
  });

  it('retries on the periodic timer too', async () => {
    h = await createDomainHarness({ handOffRetryMs: 20, adjust: roomy });
    const first = await create('One');
    const second = await create('Two');
    const third = await create('Three');
    for (const key of [first, second, third]) await move(key);
    await vi.waitFor(() => expect(waiting(third)).toMatchObject({ reason: 'no_free_member' }));
    // Capacity freed without an event the domain listens to (the card left its stage in the
    // store, its session idles): only the timer notices.
    h.repos.tasks.update(task(first).id, { stageId: 'code_review' });
    h.repos.sessions.update(sessionsOf(first)[0]!.id, { state: 'idle' });
    await vi.waitFor(() => expect(task(third).assignee).toBe('dev-1'));
  });
});
