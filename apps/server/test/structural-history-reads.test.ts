import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task, TimelineEvent } from '@projectman/shared';
import { StructuralPatterns } from '../src/services/operator/structural-patterns';
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

async function setup() {
  h = await createDomainHarness({ persistent: true, now: () => NOW });
}
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
            visibility: 'internal',
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
