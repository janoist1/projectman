import { afterEach, expect, it, vi } from 'vitest';
import { LabelDefinition, StartCondition } from '@projectman/shared';
import type { ProjectManagerSignalKind, StartCondition as Condition } from '@projectman/shared';
import { standardLabel, getLocale } from '@projectman/templates';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

let h: DomainHarness;
let now: Date;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
});

async function setup(enabled = true, activePm = false) {
  now = new Date('2026-11-14T10:00:00.000Z');
  h = await createDomainHarness({
    now: () => now,
    adjust(config) {
      const pm = config.team.members.find((member) => member.handle === 'pm');
      if (activePm && pm?.kind === 'ai') pm.onLeave = false;
      config.pipeline.stages.unshift({
        id: 'ideas',
        name: 'Ideas',
        kind: 'queue',
        columnId: 'todo',
        owners: ['owner'],
      });
      config.pipeline.labels.push(
        LabelDefinition.parse({ id: 'hold', name: 'Wait' }),
        LabelDefinition.parse({ id: 'go', name: 'Go' }),
        { ...standardLabel('refine', getLocale('en')), setBy: 'anyone' },
      );
      // Keep refinement waiting so its label can be observed without a worker finishing it.
      config.pipeline.stages.find((stage) => stage.id === 'development')!.gate = {
        conditions: [{ type: 'has_label', label: 'go' }],
      };
      if (enabled) config.team.startCondition = StartCondition.parse({ priority: 'any', hold: ['hold'] });
    },
  });
}
const later = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};
const signals = (kind: ProjectManagerSignalKind, all = false) =>
  h.repos.projectManagerSignals.list('AR').filter((s) => s.kind === kind && (all || !s.resolvedAt));
const met = () => signals('start_condition_met');
async function sweep() {
  await h.domain.projectManagerSignals.sweep('AR');
  await flush();
}
async function card(priority: 'high' | 'urgent' | null = 'high') {
  const task = await h.domain.tasks.create('AR', { title: 'Idea', stageId: 'ideas' }, OWNER_ACTOR);
  return h.domain.tasks.update('AR', task.key, { priority }, OWNER_ACTOR);
}
async function condition(value: Condition | null) {
  const loaded = await h.domain.projects.load('AR');
  const saved = await h.domain.projects.patch(
    'AR',
    {
      baseVersion: loaded.version,
      startCondition: value,
    },
    { actor: OWNER_ACTOR, author: OWNER },
  );
  await sweep();
  return { previous: loaded.version, version: saved.version };
}

it('raises one case only after grace and resolves it when priority is cleared', async () => {
  await setup();
  const task = await card();
  await sweep();
  const since = h.repos.startConditionMarks.ofProject('AR').get(task.key)!;
  later(4);
  await sweep();
  expect(met()).toEqual([]);
  later(1);
  await sweep();
  await sweep();
  expect(met()).toMatchObject([{ taskKey: task.key, caseKey: `start_condition_met:${task.key}:${since}` }]);
  await h.domain.tasks.update('AR', task.key, { priority: null }, OWNER_ACTOR);
  await sweep();
  expect(met()).toEqual([]);
});

it('reacts immediately to inherited urgent priority and delivers theme context', async () => {
  await setup();
  const theme = await h.domain.tasks.create('AR', { title: 'Theme', kind: 'theme' }, OWNER_ACTOR);
  const parent = await card(null);
  await h.domain.tasks.update('AR', parent.key, { themeKey: theme.key }, OWNER_ACTOR);
  const child = await h.domain.tasks.create(
    'AR',
    {
      title: 'Child',
      parentKey: parent.key,
      stageId: 'ideas',
    },
    OWNER_ACTOR,
  );
  await h.domain.tasks.update('AR', theme.key, { priority: 'urgent' }, OWNER_ACTOR);
  // The priority event itself must request the sweep, without a manual one.
  await vi.waitFor(() => expect(met()).toHaveLength(2));
  const signal = met().find((s) => s.taskKey === child.key)!;
  const text = await h.domain.projectManagerSignals.noticeText('AR', [signal.id]);
  const notice = JSON.parse(text.split('\n').at(-1)!);
  expect(notice.facts).toMatchObject({
    taskKey: child.key,
    stage: { id: 'ideas', name: 'Ideas' },
    effectivePriority: 'urgent',
    themeKey: theme.key,
    parentKey: parent.key,
    otherThemeSignals: [{ taskKey: parent.key }],
  });
  expect(notice.facts.refines).toBe(true);
});

it('suppresses held cards and starts a fresh grace period when a hold is removed', async () => {
  await setup();
  const task = await card('urgent');
  await sweep();
  const old = met()[0]!;
  await h.domain.tasks.update('AR', task.key, { labels: ['hold'] }, OWNER_ACTOR);
  await sweep();
  expect(met()).toEqual([]);
  later(1);
  await h.domain.tasks.update('AR', task.key, { priority: 'high', labels: [] }, OWNER_ACTOR);
  await sweep();
  expect(met()).toEqual([]);
  later(5);
  await sweep();
  expect(met()[0]!.caseKey).not.toBe(old.caseKey);
  expect(signals('start_condition_met', true).find((s) => s.id === old.id)?.resolvedAt).not.toBeNull();
});

it.each(['refine', 'ready', 'closed', 'disabled'] as const)('resolves a met case when %s', async (end) => {
  await setup();
  const task = await card('urgent');
  await sweep();
  expect(met()).toHaveLength(1);
  if (end === 'refine') await h.domain.tasks.update('AR', task.key, { labels: ['refine'] }, OWNER_ACTOR);
  if (end === 'ready') await h.domain.tasks.moveToStage('AR', task.key, 'backlog', OWNER_ACTOR);
  if (end === 'closed')
    await h.domain.tasks.cancel('AR', task.key, { reason: 'No longer needed' }, OWNER_ACTOR);
  if (end === 'disabled') await condition(null);
  await sweep();
  expect(met()).toEqual([]);
});

it('emits no new kinds in an unconfigured project, including unrelated configuration edits', async () => {
  await setup(false);
  await card('urgent');
  const loaded = await h.domain.projects.load('AR');
  await h.domain.projects.patch(
    'AR',
    { baseVersion: loaded.version, project: { name: 'Renamed' } },
    {
      actor: OWNER_ACTOR,
      author: OWNER,
    },
  );
  later(10);
  await sweep();
  expect(met()).toEqual([]);
  expect(signals('start_condition_changed')).toEqual([]);
});

it('compares priority to label selection with bounded lists, and replaces older changes', async () => {
  await setup();
  const stopped: string[] = [];
  for (let i = 0; i < 21; i++) stopped.push((await card()).key);
  const started = await card(null);
  await h.domain.tasks.update('AR', started.key, { labels: ['go'] }, OWNER_ACTOR);
  const change = await condition(StartCondition.parse({ labels: ['go'], hold: ['hold'] }));
  const signal = signals('start_condition_changed')[0]!;
  expect(signal).toMatchObject({
    subject: change.previous,
    caseKey: `start_condition_changed:${change.version}`,
  });
  const notice = JSON.parse(
    (await h.domain.projectManagerSignals.noticeText('AR', [signal.id])).split('\n').at(-1)!,
  );
  expect(notice.facts.shift).toMatchObject({
    stopped: stopped.slice(0, 20),
    stoppedCount: 21,
    started: [started.key],
    startedCount: 1,
  });
  // A queued comparison reads card labels at delivery, rather than persisting the earlier selection.
  await h.domain.tasks.update('AR', started.key, { labels: [] }, OWNER_ACTOR);
  const fresh = JSON.parse(
    (await h.domain.projectManagerSignals.noticeText('AR', [signal.id])).split('\n').at(-1)!,
  );
  expect(fresh.facts.shift).toMatchObject({ started: [], startedCount: 0 });
  await condition(null);
  expect(signals('start_condition_changed')).toHaveLength(1);
  expect(h.repos.projectManagerSignals.get(signal.id)?.resolvedAt).not.toBeNull();
});

it('reports enabling and disabling with the immediately previous version, including after revert', async () => {
  await setup(false);
  const task = await card('urgent');
  const enabled = await condition(StartCondition.parse({ priority: 'any' }));
  expect(signals('start_condition_changed')[0]?.subject).toBe(enabled.previous);
  const before = await h.domain.projects.load('AR');
  await h.domain.projects.revert('AR', enabled.previous, { actor: OWNER_ACTOR, author: OWNER });
  await sweep();
  expect(signals('start_condition_changed')[0]?.subject).toBe(before.version);
  expect(met().some((s) => s.taskKey === task.key)).toBe(false);
});

it.each([false, true])(
  'delivers an unreadable previous version without refusing the PM start (live=%s)',
  async (live) => {
    await setup(false, true);
    if (live) {
      const { session } = await h.domain.sessions.ensureSession('AR', 'pm', { type: 'general' });
      h.runner.setState(session.id, 'working');
      h.runner.setState(session.id, 'idle');
      await flush();
    }
    vi.spyOn(h.domain.projects, 'versionConfig').mockRejectedValue(new Error('Version unavailable'));
    await condition(StartCondition.parse({ priority: 'any' }));
    await vi.waitFor(() =>
      expect(signals('start_condition_changed')[0]?.deliveredAt).toEqual(expect.any(String)),
    );
    const signal = signals('start_condition_changed')[0]!;
    const text = [
      ...h.runner.started.map((s) => s.initialMessage ?? ''),
      ...h.runner.messages.map((m) => m.text),
    ].find((text) => text.includes(signal.id))!;
    expect(JSON.parse(text.split('\n').at(-1)!).facts).toMatchObject({
      previousVersion: signal.subject,
      shift: null,
    });
    expect(h.repos.memberQueue.listOpen('AR', 'pm').some((item) => item.wait?.code === 'start_failed')).toBe(
      false,
    );
  },
);
