import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task, TimelineEvent } from '@projectman/shared';
import {
  StructuralPatterns,
  patternSubject,
  STRUCTURAL_WINDOW_MS,
} from '../src/services/operator/structural-patterns';
import type { StructuralSignalRef } from '../src/services/operator/structural-patterns';
import { createDomainHarness, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

// PM-771: the milestone reconstruction reads the siblings' state before the window (not a card's whole
// history) and the detector and the operator sweep never list the project's cards.
const NOW = new Date('2026-10-16T09:00:00Z');
const SINCE = new Date(NOW.getTime() - 7 * 24 * 60 * 60_000);
const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60_000);
let h: DomainHarness;
let sequence = 0;

afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
});

async function setup(activePm = false) {
  h = await createDomainHarness({
    persistent: true,
    now: () => NOW,
    adjust: (config) => {
      const pm = config.team.members.find((member) => member.handle === 'pm')!;
      if (activePm && pm.kind === 'ai') pm.onLeave = false;
    },
  });
  for (const kind of ['structural_pattern', 'milestone_closed'] as const)
    h.repos.operatorSignals.arm('AR', kind, '2026-09-01T00:00:00.000Z');
}
/** The member queue's driver does not run, so only the reads of the signal service itself are counted. */
const holdTheDriver = () =>
  vi.spyOn(h.domain.memberQueueDriver, 'ensure').mockImplementation(async () => undefined as never);
const config = () => h.domain.projects.cachedConfig('AR')!;
const report = (until?: string) => new StructuralPatterns(h.domain.ctx).report(config(), until);
const card = (title = 'Card') => h.domain.tasks.create('AR', { title, repo: 'web' }, OWNER_ACTOR);
function event(
  taskKey: string,
  type: TimelineEvent['type'],
  data: Record<string, unknown>,
  at: Date,
  projectKey = 'AR',
) {
  const entry: TimelineEvent = {
    id: `evt_history_${++sequence}`,
    projectKey,
    taskKey,
    sessionId: null,
    actor: { kind: 'system', handle: null },
    type,
    data,
    createdAt: at.toISOString(),
  };
  h.repos.timeline.insert(entry);
  return entry;
}
const done = (key: string, at: Date) =>
  event(key, 'task_stage_changed', { from: 'development', to: 'done' }, at);
const cancelled = (key: string, at: Date) =>
  event(key, 'task_updated', { action: 'cancelled', previousStatus: 'active' }, at);
const reopened = (key: string, at: Date) =>
  event(key, 'task_updated', { action: 'reopened', previousStatus: 'done' }, at);
async function family(children = 3) {
  const parent = await card('Parent');
  const subtasks: Task[] = [];
  for (let i = 0; i < children; i++) {
    const child = await card(`Part ${i}`);
    h.repos.tasks.update(child.id, { parentKey: parent.key });
    subtasks.push(child);
  }
  return { parent, subtasks };
}

describe('milestones from the state at the closing event', () => {
  it('counts siblings that closed or were cancelled before the window, closed ones included', async () => {
    await setup();
    const { parent, subtasks } = await family();
    const [a, b, c] = subtasks as [Task, Task, Task];
    done(a.key, days(30));
    cancelled(b.key, days(20));
    // The stored rows of these siblings are done and cancelled now; the card list is not the evidence.
    h.repos.tasks.update(a.id, { status: 'done' });
    h.repos.tasks.update(b.id, { status: 'cancelled' });
    const last = done(c.key, days(1));
    expect(report().milestones).toEqual([{ taskKey: parent.key, eventId: last.id }]);
  });

  it('does not close a family whose earlier sibling has no history, or was reopened before the window', async () => {
    await setup();
    const unknown = await family(2);
    done(unknown.subtasks[1]!.key, days(1));
    expect(report().milestones).toEqual([]);

    const reopenedFamily = await family(2);
    done(reopenedFamily.subtasks[0]!.key, days(30));
    reopened(reopenedFamily.subtasks[0]!.key, days(20));
    done(reopenedFamily.subtasks[1]!.key, days(1));
    expect(report().milestones).toEqual([]);

    // Done again before the window: the latest event wins.
    done(reopenedFamily.subtasks[0]!.key, days(10));
    const closing = done(reopenedFamily.subtasks[1]!.key, days(1));
    expect(report().milestones).toContainEqual({ taskKey: reopenedFamily.parent.key, eventId: closing.id });
  });

  it('replays the window from its start: the boundary event belongs to the window, the one before to history', async () => {
    await setup();
    const { parent, subtasks } = await family(2);
    const [a, b] = subtasks as [Task, Task];
    done(a.key, new Date(SINCE.getTime() - 1));
    // Reopened exactly at the window start: replayed, so a's later state is open when b closes.
    reopened(a.key, SINCE);
    done(b.key, days(1));
    expect(report().milestones).toEqual([]);
    // The window is replayed in seq order, not by creation time: a closes last.
    const again = done(a.key, days(2));
    expect(report().milestones).toEqual([{ taskKey: parent.key, eventId: again.id }]);
  });

  it('orders events created at the same time by their seq', async () => {
    await setup();
    const first = await family(2);
    const at = days(1);
    done(first.subtasks[0]!.key, at);
    const second = done(first.subtasks[1]!.key, at);
    expect(report().milestones).toEqual([{ taskKey: first.parent.key, eventId: second.id }]);

    const other = await family(2);
    done(other.subtasks[1]!.key, at);
    const closing = done(other.subtasks[0]!.key, at);
    expect(report().milestones).toContainEqual({ taskKey: other.parent.key, eventId: closing.id });
  });

  it('ignores another project that has events for the same key, and a closed theme still counts', async () => {
    await setup();
    h.repos.projects.insert({
      key: 'OT',
      name: 'Other',
      templateId: null,
      configVersion: 'v1',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const { parent, subtasks } = await family(2);
    const [a, b] = subtasks as [Task, Task];
    // A foreign "done" of a must not be a's state before the window.
    event(a.key, 'task_stage_changed', { from: 'development', to: 'done' }, days(30), 'OT');
    done(b.key, days(1));
    expect(report().milestones).toEqual([]);
    done(a.key, days(30));
    expect(report().milestones).toContainEqual({ taskKey: parent.key, eventId: expect.any(String) });

    const theme = await h.domain.tasks.create('AR', { title: 'Theme', kind: 'theme' }, OWNER_ACTOR);
    const closed = event(theme.key, 'task_updated', { action: 'closed', previousStatus: 'active' }, days(1));
    expect(report().milestones).toContainEqual({ taskKey: theme.key, eventId: closed.id });
  });

  it('raises nothing new on a repeated sweep or after a restart', async () => {
    await setup();
    const { parent, subtasks } = await family(2);
    done(subtasks[0]!.key, days(30));
    const closing = done(subtasks[1]!.key, days(1));
    const milestones = () =>
      h.repos.operatorSignals.list('AR').filter((signal) => signal.kind === 'milestone_closed');
    await h.domain.operatorSignals.sweep('AR');
    await h.domain.operatorSignals.sweep('AR');
    expect(milestones().map((signal) => [signal.taskKey, signal.subject])).toEqual([
      [parent.key, closing.id],
    ]);
    h = await restartDomainHarness(h, { now: () => NOW });
    await h.domain.operatorSignals.sweep('AR');
    expect(milestones()).toHaveLength(1);
  });
});

describe('the wait and the roster read only what they need', () => {
  it('reads the named prerequisite targets and the open cards, never the project list', async () => {
    await setup();
    const dependent = await card('Dependent');
    const open = await card('Open prerequisite');
    const closed = await card('Closed prerequisite');
    await h.domain.tasks.update(
      'AR',
      dependent.key,
      {
        relations: {
          add: [
            { kind: 'prerequisite' as const, key: open.key },
            { kind: 'prerequisite' as const, key: closed.key },
          ],
        },
      },
      OWNER_ACTOR,
    );
    h.repos.tasks.update(closed.id, { status: 'done', stageId: 'done' });
    for (let i = 0; i < 5; i++) await card(`Unrelated ${i}`);
    const read = vi.spyOn(h.repos.tasks, 'readScheduling');
    const list = vi.spyOn(h.repos.tasks, 'list');
    const stored = h.repos.tasks.list('AR').find((entry) => entry.key === dependent.key)!;
    list.mockClear();
    const waits = h.domain.taskWaits.of(config(), [stored]);
    expect(waits.get(dependent.key)).toMatchObject({
      reason: 'prerequisite',
      prerequisites: [open.key],
    });
    expect(list).not.toHaveBeenCalled();
    const queries = read.mock.calls.map(([, query]) => query);
    expect(queries).toContainEqual({ kind: 'keys', keys: [open.key, closed.key] });
    expect(queries).toContainEqual({ kind: 'open' });
    expect(queries.every((query) => query.kind === 'keys' || query.kind === 'open')).toBe(true);
  });
});

describe('reads that do not grow with the unrelated history', () => {
  // The cards a periodic path hydrates, by history size: tenfold more closed families change nothing.
  async function hydrated(closedFamilies: number) {
    await setup();
    const { subtasks } = await family(2);
    done(subtasks[0]!.key, days(30));
    done(subtasks[1]!.key, days(1));
    h.repos.transaction(() => {
      for (let n = 0; n < closedFamilies; n++) {
        const base = 1_000 + n * 5;
        for (let i = 0; i < 5; i++) {
          const key = `AR-${base + i}`;
          h.repos.tasks.insert({
            id: `task_noise_${key}`,
            key,
            projectKey: 'AR',
            title: 'Closed noise',
            description: '',
            stageId: 'done',
            status: 'done',
            assignee: null,
            repo: 'web',
            priority: null,
            labels: [],
            links: [],
            parentKey: i === 0 ? null : `AR-${base}`,
            createdBy: 'owner',
            createdAt: days(60).toISOString(),
            updatedAt: days(60).toISOString(),
            closedAt: days(60).toISOString(),
          });
          done(key, days(60));
        }
      }
    });
    const read = vi.spyOn(h.repos.tasks, 'readScheduling');
    const list = vi.spyOn(h.repos.tasks, 'list');
    const children = vi.spyOn(h.repos.tasks, 'children');
    const history = vi.spyOn(h.repos.timeline, 'listOfTypes');
    report();
    await h.domain.operatorSignals.sweep('AR');
    return {
      cards: read.mock.results.reduce((sum, result) => sum + (result.value as Task[]).length, 0),
      listed: list.mock.calls.length,
      children: children.mock.calls.length,
      histories: history.mock.calls.length,
    };
  }

  it('hydrates the same cards, lists none, and reads no card history at ten times the closed history', async () => {
    const small = await hydrated(10);
    await h.cleanup();
    const large = await hydrated(100);
    expect(large).toEqual(small);
    expect(large.listed).toBe(0);
    expect(large.children).toBe(0);
    expect(large.histories).toBe(0);
    expect(large.cards).toBeGreaterThan(0);
  });
});

describe('synchronous structural evaluations (PM-783)', () => {
  async function mixed(count = 10) {
    await setup(true);
    const { parent, subtasks } = await family(2);
    done(subtasks[0]!.key, days(30));
    const closing = done(subtasks[1]!.key, days(1));
    const files = Array.from({ length: count }, (_, n) => `src/case-${n}.test.ts`);
    const failures = subtasks.map((task) =>
      event(
        task.key,
        'task_full_test',
        {
          outcome: 'failed',
          repo: 'web',
          failedFiles: files,
        },
        days(1),
      ),
    );
    const refs: StructuralSignalRef[] = [
      {
        projectKey: 'AR',
        kind: 'milestone_closed',
        taskKey: parent.key,
        subject: closing.id,
        raisedAt: days(0.5).toISOString(),
      },
      ...files.map((file) => ({
        projectKey: 'AR',
        kind: 'structural_pattern' as const,
        taskKey: null,
        subject: patternSubject(JSON.stringify(['failed_test_file', 'web', file])),
        raisedAt: days(0.5).toISOString(),
      })),
    ];
    return { refs, failures, subtasks };
  }

  it('shares exact windows and reconstructs milestones only for the current window', async () => {
    const { refs, failures, subtasks } = await mixed();
    const evidence = vi.spyOn(h.repos.timeline, 'structuralEvidence');
    const states = vi.spyOn(h.repos.timeline, 'latestTaskStatesBefore');
    const read = vi.spyOn(h.repos.tasks, 'readScheduling');
    const evaluation = new StructuralPatterns(h.domain.ctx).evaluate(config());
    expect(evidence).not.toHaveBeenCalled();
    for (let repeat = 0; repeat < 3; repeat++)
      for (const ref of refs) expect(evaluation.facts(ref)).not.toBeNull();
    expect(evidence.mock.calls.map(([, , until]) => until)).toEqual([NOW.toISOString(), refs[0]!.raisedAt]);
    expect(states).toHaveBeenCalledTimes(1);
    expect(read.mock.calls.filter(([, query]) => query.kind === 'children')).toHaveLength(1);
    // Fixed pre-optimization fixture: original time bounds, normalized fingerprint and event order.
    expect(evaluation.facts(refs[1]!)).toEqual({
      evidence: {
        kind: 'failed_test_file',
        fingerprint: '["failed_test_file","web","src/case-0.test.ts"]',
        taskKeys: subtasks.map((task) => task.key).sort(),
        eventIds: failures.map((entry) => entry.id),
        windowStartedAt: new Date(Date.parse(refs[1]!.raisedAt) - STRUCTURAL_WINDOW_MS).toISOString(),
        windowEndedAt: refs[1]!.raisedAt,
      },
      milestoneKey: null,
    });
    const another = { ...refs[1]!, raisedAt: new Date(Date.parse(refs[1]!.raisedAt) + 1).toISOString() };
    expect(evaluation.facts(another)?.evidence?.windowEndedAt).toBe(another.raisedAt);
    expect(evidence).toHaveBeenCalledTimes(3);
    expect(states).toHaveBeenCalledTimes(1);
    evaluation.report();
    expect(evidence).toHaveBeenCalledTimes(3);
    expect(states).toHaveBeenCalledTimes(1);
  });

  it('shares the evaluation across all pending signals and starts a fresh one for each holdsBack call', async () => {
    const { refs, subtasks } = await mixed();
    const ids = refs.map((ref) => {
      const signal = h.domain.operatorSignals.raise({ ...ref, caseKey: `fixture:${ref.subject}` });
      h.repos.db
        .prepare('UPDATE operator_signals SET raised_at = ? WHERE id = ?')
        .run(ref.raisedAt, signal.id);
      return signal.id;
    });
    holdTheDriver();
    const evidence = vi.spyOn(h.repos.timeline, 'structuralEvidence');
    const states = vi.spyOn(h.repos.timeline, 'latestTaskStatesBefore');
    await h.domain.operatorSignals.deliver('AR');
    expect(evidence).toHaveBeenCalledTimes(2);
    expect(states).toHaveBeenCalledTimes(1);
    expect(h.domain.operatorSignals.holdsBack('AR', ids[0]!)).toBe(false);
    expect(evidence).toHaveBeenCalledTimes(3); // Only the asked signal's case is read, not every open one.
    // Changing a card invalidates its milestone and the patterns that need both cards.
    h.repos.tasks.update(subtasks[1]!.id, { parentKey: null });
    h.repos.db.prepare('DELETE FROM timeline_events WHERE task_key = ?').run(subtasks[1]!.key);
    expect(h.domain.operatorSignals.holdsBack('AR', ids[0]!)).toBe(true);
    expect(evidence).toHaveBeenCalledTimes(4); // No historical pattern read without a current subject.
    // The hold only reads; the next delivery (the 60 s sweep) resolves the signals whose case is gone.
    expect(h.repos.operatorSignals.list('AR').some((signal) => signal.resolvedAt)).toBe(false);
    await h.domain.operatorSignals.deliver('AR');
    expect(
      h.repos.operatorSignals
        .list('AR')
        .filter((signal) => ['structural_pattern', 'milestone_closed'].includes(signal.kind))
        .every((signal) => signal.resolvedAt),
    ).toBe(true);
  });

  describe('the queue hold (PM-1106)', () => {
    const raiseAll = (refs: StructuralSignalRef[]) =>
      refs.map((ref) => {
        const signal = h.domain.operatorSignals.raise({ ...ref, caseKey: `fixture:${ref.subject}` });
        h.repos.db
          .prepare('UPDATE operator_signals SET raised_at = ? WHERE id = ?')
          .run(ref.raisedAt, signal.id);
        return signal.id;
      });

    /** What one run of the queue's hold reads and writes for this many waiting signals. */
    async function holdCost(count: number) {
      // The same kind of waiting signal at any count: one pattern per failing test file.
      const { refs } = await mixed(count);
      const ids = raiseAll(refs.slice(1));
      holdTheDriver();
      const reads = {
        evidence: vi.spyOn(h.repos.timeline, 'structuralEvidence'),
        list: vi.spyOn(h.repos.operatorSignals, 'list'),
        listOpen: vi.spyOn(h.repos.operatorSignals, 'listOpen'),
        board: vi.spyOn(h.domain.operatorSignals as never, 'boardRead'),
      };
      const changes = () => (h.repos.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
      const before = changes();
      const held = h.domain.operatorSignals.heldBack('AR', ids);
      expect(held.size).toBe(0);
      expect(changes()).toBe(before);
      return Object.values(reads).map((spy) => spy.mock.calls.length);
    }

    it('costs the same reads for one waiting signal as for fifty', async () => {
      const one = await holdCost(1);
      await h.cleanup();
      vi.restoreAllMocks();
      const fifty = await holdCost(50);
      expect(one[0]).toBeGreaterThan(0);
      expect(fifty).toEqual(one);
    });

    it('holds a signal whose wake line is not due without reading its case', async () => {
      const { refs } = await mixed(2);
      const ids = raiseAll(refs);
      h.repos.operatorSignals.delivered([ids[0]!], NOW.toISOString(), 'pm');
      holdTheDriver();
      const evidence = vi.spyOn(h.repos.timeline, 'structuralEvidence');
      const held = h.domain.operatorSignals.heldBack('AR', ids.slice(1));
      expect([...held.keys()]).toEqual(ids.slice(1));
      expect([...held.values()].every((why) => why === 'interval')).toBe(true);
      expect(evidence).not.toHaveBeenCalled();
    });

    it('names a gone case apart from the interval', async () => {
      const { refs, subtasks } = await mixed(3);
      const ids = raiseAll(refs);
      holdTheDriver();
      h.repos.tasks.update(subtasks[1]!.id, { parentKey: null });
      h.repos.db.prepare('DELETE FROM timeline_events WHERE task_key = ?').run(subtasks[1]!.key);
      expect(h.domain.operatorSignals.heldBack('AR', ids.slice(0, 1)).get(ids[0]!)).toBe('unready');
    });
  });

  it('does no structural reads for nonstructural, foreign, expired or ineligible pending signals', async () => {
    const { refs } = await mixed();
    const evidence = vi.spyOn(h.repos.timeline, 'structuralEvidence');
    const evaluation = new StructuralPatterns(h.domain.ctx).evaluate(config());
    expect(evaluation.facts({ ...refs[1]!, projectKey: 'OT' })).toBeNull();
    expect(evaluation.facts({ ...refs[1]!, kind: 'outage' })).toBeNull();
    expect(evaluation.facts({ ...refs[1]!, raisedAt: SINCE.toISOString() })).toBeNull();
    expect(
      h.domain.operatorSignals.structuralFacts({
        ...h.domain.operatorSignals.raise({ projectKey: 'AR', kind: 'outage', caseKey: 'outage:pending' }),
        projectKey: 'missing',
      }),
    ).toBeNull();
    await h.domain.operatorSignals.deliver('AR');
    const signal = h.domain.operatorSignals.raise({ ...refs[1]!, caseKey: 'fixture:resolved' });
    h.domain.operatorSignals.resolve('AR', signal.caseKey);
    await h.domain.operatorSignals.deliver('AR');
    expect(evidence).not.toHaveBeenCalled();
  });

  it('rejects a current subject without an original pattern, without reading historical milestones', async () => {
    const { refs } = await mixed();
    const states = vi.spyOn(h.repos.timeline, 'latestTaskStatesBefore');
    const evidence = vi.spyOn(h.repos.timeline, 'structuralEvidence');
    const evaluation = new StructuralPatterns(h.domain.ctx).evaluate(config());
    expect(evaluation.facts({ ...refs[1]!, raisedAt: days(2).toISOString() })).toBeNull();
    expect(states).not.toHaveBeenCalled();
    expect(evidence).toHaveBeenCalledTimes(2);
    expect(evaluation.facts({ ...refs[1]!, subject: 'absent' })).toBeNull();
    expect(evidence).toHaveBeenCalledTimes(2);
  });

  it('shares the sweep report with the delivery and remains fresh when the lane asks later', async () => {
    const { subtasks } = await mixed();
    holdTheDriver();
    const evidence = vi.spyOn(h.repos.timeline, 'structuralEvidence');
    const states = vi.spyOn(h.repos.timeline, 'latestTaskStatesBefore');
    await h.domain.operatorSignals.sweep('AR');
    expect(evidence).toHaveBeenCalledTimes(1); // report, pending and all original windows coincide.
    expect(states).toHaveBeenCalledTimes(1);
    const owed = h.repos.operatorSignals
      .list('AR')
      .filter((signal) => ['structural_pattern', 'milestone_closed'].includes(signal.kind));
    expect(owed.length).toBeGreaterThan(0);
    h.repos.db.prepare('DELETE FROM timeline_events WHERE task_key = ?').run(subtasks[1]!.key);
    h.repos.tasks.update(subtasks[1]!.id, { parentKey: null });
    for (const signal of owed) expect(h.domain.operatorSignals.holdsBack('AR', signal.id)).toBe(true);
    expect(h.runner.started).toHaveLength(0);
    await h.domain.operatorSignals.deliver('AR');
    expect(
      h.repos.operatorSignals
        .list('AR')
        .filter((signal) => ['structural_pattern', 'milestone_closed'].includes(signal.kind))
        .every((signal) => signal.resolvedAt),
    ).toBe(true);
  });

  it('shares post-config validation with the facts payload and spends no delivery budget on failure', async () => {
    const { refs } = await mixed();
    for (const ref of refs) {
      const signal = h.domain.operatorSignals.raise({ ...ref, caseKey: `payload:${ref.subject}` });
      h.repos.db
        .prepare('UPDATE operator_signals SET raised_at = ? WHERE id = ?')
        .run(ref.raisedAt, signal.id);
    }
    // The queue's driver does not run: the payload is built, the delivery receipt is not written.
    holdTheDriver();
    await h.domain.operatorSignals.deliver('AR');
    const ids = h.repos.operatorSignals.list('AR').map((signal) => signal.id);
    const evidence = vi.spyOn(h.repos.timeline, 'structuralEvidence');
    const states = vi.spyOn(h.repos.timeline, 'latestTaskStatesBefore');
    const payload = h.domain.operatorSignals.noticeText('AR', ids);
    expect(evidence).toHaveBeenCalledTimes(2);
    expect(states).toHaveBeenCalledTimes(1);
    expect(payload).toContain(`"windowEndedAt":"${refs[1]!.raisedAt}"`);
    expect(payload).toContain(`"milestoneKey":"${refs[0]!.taskKey}"`);
    expect(h.repos.operatorSignals.list('AR').every((signal) => !signal.deliveredAt)).toBe(true);
    for (const id of ids) h.domain.operatorSignals.markDelivered('AR', 'pm', id, null);
    expect(h.repos.operatorSignals.list('AR').every((signal) => signal.deliveredAt)).toBe(true);
  });

  it.each(['expiry', 'config'] as const)('rechecks %s when the lane asks again', async (change) => {
    const { refs } = await mixed();
    const signal = h.domain.operatorSignals.raise({ ...refs[0]!, caseKey: 'fresh:milestone' });
    holdTheDriver();
    await h.domain.operatorSignals.deliver('AR');
    expect(h.domain.operatorSignals.holdsBack('AR', signal.id)).toBe(false);
    await Promise.resolve();
    if (change === 'expiry')
      vi.spyOn(h.domain.ctx, 'now').mockReturnValue(new Date(NOW.getTime() + STRUCTURAL_WINDOW_MS));
    else config().pipeline.stages.find((stage) => stage.id === 'done')!.kind = 'work';
    expect(h.domain.operatorSignals.holdsBack('AR', signal.id)).toBe(true);
    expect(h.repos.operatorSignals.get(signal.id)?.resolvedAt).toBeNull();
    await h.domain.operatorSignals.deliver('AR');
    expect(h.repos.operatorSignals.get(signal.id)?.resolvedAt).not.toBeNull();
  });
});

describe('conflict request history sharing (PM-783)', () => {
  it('reads each task and missing merge once across current and original windows, retaining the first request', async () => {
    await setup();
    const cards = [await card(), await card()];
    for (const task of cards) {
      event(task.key, 'task_merge_requested', { mergeId: 'missing', repo: 'recorded' }, days(30));
      event(task.key, 'task_merge_requested', { mergeId: 'missing', repo: 'later' }, days(20));
      for (let repeat = 0; repeat < 8; repeat++)
        event(
          task.key,
          'task_merge_failed',
          {
            mergeId: 'missing',
            reason: 'conflict',
            files: ['src/shared.ts'],
          },
          days(1),
        );
    }
    const requests = vi.spyOn(h.repos.timeline, 'listOfTypes');
    const merges = vi.spyOn(h.repos.taskMerges, 'get');
    const evaluation = new StructuralPatterns(h.domain.ctx).evaluate(config());
    const patterns = evaluation.report().patterns;
    expect(patterns).toMatchObject([
      { kind: 'conflict_file', fingerprint: '["conflict_file","recorded","src/shared.ts"]' },
    ]);
    const ref: StructuralSignalRef = {
      projectKey: 'AR',
      kind: 'structural_pattern',
      taskKey: null,
      subject: patternSubject(patterns[0]!.fingerprint),
      raisedAt: days(0.5).toISOString(),
    };
    expect(evaluation.facts(ref)?.evidence?.fingerprint).toBe(patterns[0]!.fingerprint);
    expect(requests.mock.calls).toEqual(
      cards.map((task) => ['AR', task.key, ['task_merge_requested'], 1000]),
    );
    expect(merges.mock.calls).toEqual([['missing']]);
  });

  it('preserves the 1000-request limit, nullish repo fallback and project isolation', async () => {
    await setup();
    const cards = [await card(), await card()];
    for (const task of cards) {
      // This matching request is the 1001st oldest and must be excluded by the existing limit.
      event(task.key, 'task_merge_requested', { mergeId: 'limited', repo: 'excluded' }, days(30));
      for (let n = 0; n < 1000; n++)
        event(task.key, 'task_merge_requested', { mergeId: `other-${n}`, repo: 'noise' }, days(30));
      for (const mergeId of ['limited', 'foreign', 'empty', 'null', undefined]) {
        if (mergeId === 'empty' || mergeId === 'null')
          event(
            task.key,
            'task_merge_requested',
            { mergeId, repo: mergeId === 'empty' ? '' : null },
            days(20),
          );
        event(
          task.key,
          'task_merge_failed',
          { mergeId, reason: 'conflict', files: [`${mergeId}.ts`] },
          days(1),
        );
      }
    }
    // Persist actual merge rows; the card's current repository must never provide the fallback.
    for (const id of ['limited', 'foreign', 'empty', 'null'])
      h.repos.taskMerges.save({
        id,
        projectKey: id === 'foreign' ? 'OT' : 'AR',
        taskKey: cards[0]!.key,
        repo: 'fallback',
        base: 'main',
        branch: 'fixture',
        commit: 'a'.repeat(40),
        fromStageId: 'development',
        toStageId: 'done',
        merger: 'cr',
        requestedAt: NOW.toISOString(),
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        state: 'cancelled',
        landed: 'nowhere',
      });
    expect(report().patterns.map((facts) => facts.fingerprint)).toEqual([
      '["conflict_file","fallback","limited.ts"]',
      '["conflict_file","fallback","null.ts"]',
    ]);
  });
});
