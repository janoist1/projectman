import type { MemberView, Stage, Task, WorkDoing } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import { buildConfig, tasks } from '../mocks/fixtures';
import { mockIndexes } from '../test/render';
import { cardsLine, workingCardKeys } from './members';
import { cardWorkerRows, deriveTaskState, groupOpenInboxByTask } from './taskState';
import type { TaskStateContext } from './taskState';

const COMMAND = 'Bash: npm test';
const base = mockIndexes();
const config = buildConfig();

const card = (key: string): Task => {
  const found = tasks.find((task) => task.key === key);
  if (!found) throw new Error(`no fixture ${key}`);
  return found;
};

/** AC-20 sits in Fejlesztés (a work stage, assignee be-1); AC-21 in QA (a step stage). */
const work = (handle: string, taskKey: string, since: string, doing?: WorkDoing) => ({
  sessionId: `ses_${handle}`,
  taskKey,
  activity: COMMAND,
  since,
  ...(doing ? { doing } : {}),
});

/** The fixture team with exactly these members working on the card; nobody else works. */
function contextWith(
  workers: { handle: string; taskKey: string; since: string; role?: string; doing?: WorkDoing }[],
  stageOwners: Record<string, string[]> = {},
): TaskStateContext {
  const members = new Map<string, MemberView>(
    [...base.members].map(([handle, member]) => {
      const found = workers.find((worker) => worker.handle === handle);
      return [
        handle,
        {
          ...member,
          ...(found?.role ? { role: found.role, roles: [found.role] } : {}),
          taskWork: found ? [work(handle, found.taskKey, found.since, found.doing)] : [],
        },
      ];
    }),
  );
  const stages = base.pipeline.stages.map((stage): Stage =>
    stageOwners[stage.id] ? { ...stage, owners: stageOwners[stage.id]! } : stage,
  );
  return {
    pipeline: { ...base.pipeline, stages, stageById: new Map(stages.map((stage) => [stage.id, stage])) },
    members,
    openInboxByTask: groupOpenInboxByTask([]),
    tasksByKey: new Map(tasks.map((task) => [task.key, task])),
    myHandle: 'owner',
    labels: config.pipeline.labels.map((label) => ({ ...label, holders: [] })),
  };
}

const name = (ctx: TaskStateContext, handle: string) => ctx.members.get(handle)!.displayName;
const sentence = (verb: string, who: string) =>
  t(`taskStatus.worker.${verb}` as 'taskStatus.worker.working', { name: who });

describe('who works on a card (PM-237)', () => {
  it('names a developer in a work stage as working on it, with the session the command runs in', () => {
    const ctx = contextWith([{ handle: 'be-1', taskKey: 'AC-20', since: '2026-10-01T10:00:00.000Z' }]);
    const state = deriveTaskState(card('AC-20'), ctx);
    expect(state.phase).toBe('working');
    expect(state.label).toBe(sentence('working', name(ctx, 'be-1')));
    expect(state.since).toBe('2026-10-01T10:00:00.000Z');
    expect(state.worker?.handle).toBe('be-1');
    expect(state.workers.map((worker) => worker.sessionId)).toEqual(['ses_be-1']);
  });

  it('never puts the command a session runs into the label or a sentence', () => {
    const ctx = contextWith([
      { handle: 'be-1', taskKey: 'AC-20', since: '2026-10-01T10:00:00.000Z' },
      { handle: 'fe-1', taskKey: 'AC-20', since: '2026-10-01T10:05:00.000Z' },
      { handle: 'dev-1', taskKey: 'AC-20', since: '2026-10-01T10:10:00.000Z' },
    ]);
    const state = deriveTaskState(card('AC-20'), ctx);
    expect([state.label, ...state.workers.map((worker) => worker.sentence)].join(' ')).not.toMatch(
      /Bash|npm/,
    );
  });

  describe('the verb', () => {
    it('comes from the role first: QA tests, a designer designs, an analyst analyses', () => {
      for (const [role, verb] of [
        ['qa', 'testing'],
        ['code_review', 'reviewing'],
        ['security_review', 'reviewing'],
        ['designer', 'designing'],
        ['architect', 'designing'],
        ['business_analyst', 'analysing'],
      ] as const) {
        const ctx = contextWith([
          { handle: 'fe-1', taskKey: 'AC-20', since: '2026-10-01T10:00:00.000Z', role },
        ]);
        const state = deriveTaskState(card('AC-20'), ctx);
        expect(state.workers[0]!.verb).toBe(verb);
        expect(state.label).toBe(sentence(verb, name(ctx, 'fe-1')));
      }
    });

    it('is "reviews" for the owner of a step stage the card stands in, whatever their role', () => {
      // AC-21 stands in QA (a step stage); the developer fe-1 owns it here, as the lead developer owns review.
      const ctx = contextWith([{ handle: 'fe-1', taskKey: 'AC-21', since: '2026-10-01T10:00:00.000Z' }], {
        qa: ['fe-1'],
      });
      const state = deriveTaskState({ ...card('AC-21'), assignee: 'be-1', status: 'active' }, ctx);
      expect(state.workers[0]).toMatchObject({ verb: 'reviewing' });
      expect(state.label).toBe(sentence('reviewing', name(ctx, 'fe-1')));
    });

    it('is plain "working" otherwise: a developer in a work stage, or a member who does not own the step', () => {
      const dev = contextWith([{ handle: 'fe-1', taskKey: 'AC-20', since: '2026-10-01T10:00:00.000Z' }]);
      expect(deriveTaskState(card('AC-20'), dev).workers[0]!.verb).toBe('working');
      const notOwner = contextWith([{ handle: 'fe-1', taskKey: 'AC-21', since: '2026-10-01T10:00:00.000Z' }]);
      expect(deriveTaskState({ ...card('AC-21'), status: 'active' }, notOwner).workers[0]!.verb).toBe(
        'working',
      );
    });
  });

  describe('the order and the line on the card', () => {
    const early = '2026-10-01T10:00:00.000Z';
    const mid = '2026-10-01T10:05:00.000Z';
    const late = '2026-10-01T10:10:00.000Z';

    it('names the owner of the current step first, then the assignee, then the rest by when they began', () => {
      // AC-21 stands in QA (a step stage, owner qa) and is assigned to fe-1.
      const ctx = contextWith([
        { handle: 'be-1', taskKey: 'AC-21', since: early },
        { handle: 'fe-1', taskKey: 'AC-21', since: late },
        { handle: 'dev-1', taskKey: 'AC-21', since: mid },
        { handle: 'qa', taskKey: 'AC-21', since: late },
      ]);
      expect(deriveTaskState(card('AC-21'), ctx).workers.map((worker) => worker.member.handle)).toEqual([
        'qa',
        'fe-1',
        'be-1',
        'dev-1',
      ]);
    });

    it('puts the assignee first in a work stage, whose owners are the whole pool of developers', () => {
      const ctx = contextWith([
        { handle: 'fe-1', taskKey: 'AC-20', since: early },
        { handle: 'be-1', taskKey: 'AC-20', since: late },
      ]);
      expect(deriveTaskState(card('AC-20'), ctx).workers.map((worker) => worker.member.handle)).toEqual([
        'be-1',
        'fe-1',
      ]);
    });

    it('says one worker as a sentence', () => {
      const ctx = contextWith([{ handle: 'be-1', taskKey: 'AC-20', since: early }]);
      expect(deriveTaskState(card('AC-20'), ctx).label).toBe(sentence('working', name(ctx, 'be-1')));
    });

    it('names two workers, sharing the verb, as a developer and a designer together', () => {
      const ctx = contextWith([
        { handle: 'be-1', taskKey: 'AC-20', since: early },
        { handle: 'fe-1', taskKey: 'AC-20', since: mid, role: 'designer' },
      ]);
      const state = deriveTaskState(card('AC-20'), ctx);
      expect(state.label).toBe(
        t('taskStatus.workersTwo', { names: `${name(ctx, 'be-1')}${t('common.and')}${name(ctx, 'fe-1')}` }),
      );
      // The drawer lists each with their own verb.
      expect(state.workers.map((worker) => worker.sentence)).toEqual([
        sentence('working', name(ctx, 'be-1')),
        sentence('designing', name(ctx, 'fe-1')),
      ]);
      expect(state.since).toBe(early);
    });

    it('names two and counts the rest from three on', () => {
      const ctx = contextWith([
        { handle: 'be-1', taskKey: 'AC-20', since: early },
        { handle: 'fe-1', taskKey: 'AC-20', since: mid },
        { handle: 'dev-1', taskKey: 'AC-20', since: late },
      ]);
      expect(deriveTaskState(card('AC-20'), ctx).label).toBe(
        t('taskStatus.workersMany', {
          names: `${name(ctx, 'be-1')}${t('common.listSeparator')}${name(ctx, 'fe-1')}`,
          more: 1,
        }),
      );
    });
  });

  it('has no workers unless the card is being worked on', () => {
    const ctx = contextWith([]);
    expect(deriveTaskState(card('AC-20'), ctx).workers).toEqual([]);
    expect(deriveTaskState(card('AC-16'), ctx).workers).toEqual([]);
  });
});

describe('what a worker says they do (PM-239)', () => {
  const early = '2026-10-01T10:00:00.000Z';
  const mid = '2026-10-01T10:05:00.000Z';
  const late = '2026-10-01T10:10:00.000Z';
  const gateway = { summary: 'A hálózati kapu tesztjei készülnek', detail: 'A hibaágak jönnek utoljára.' };
  const diff = { summary: 'A diff átnézése folyik' };

  it('takes the sentence over from the work and reads "{name}: {summary}"', () => {
    const ctx = contextWith([{ handle: 'be-1', taskKey: 'AC-20', since: early, doing: gateway }]);
    const [worker] = deriveTaskState(card('AC-20'), ctx).workers;
    expect(worker).toMatchObject({ doing: gateway, line: `${name(ctx, 'be-1')}: ${gateway.summary}` });
    // The capacity sentence stays for a card with no sentence on it.
    expect(worker!.sentence).toBe(sentence('working', name(ctx, 'be-1')));
  });

  it('falls back to the capacity sentence when the member gave none', () => {
    const ctx = contextWith([{ handle: 'be-1', taskKey: 'AC-20', since: early }]);
    const state = deriveTaskState(card('AC-20'), ctx);
    expect(state.workers[0]).toMatchObject({ doing: null, line: sentence('working', name(ctx, 'be-1')) });
    expect(cardWorkerRows(state)).toBeNull();
  });

  it('keeps the label of the card as it was: the sentence is the member’s, the label says who works', () => {
    const ctx = contextWith([{ handle: 'be-1', taskKey: 'AC-20', since: early, doing: gateway }]);
    expect(deriveTaskState(card('AC-20'), ctx).label).toBe(sentence('working', name(ctx, 'be-1')));
  });

  describe('the rows of the card', () => {
    it('is empty while nobody has a sentence, with one worker or several', () => {
      const one = contextWith([{ handle: 'be-1', taskKey: 'AC-20', since: early }]);
      expect(cardWorkerRows(deriveTaskState(card('AC-20'), one))).toBeNull();
      const two = contextWith([
        { handle: 'be-1', taskKey: 'AC-20', since: early },
        { handle: 'fe-1', taskKey: 'AC-20', since: mid },
      ]);
      expect(cardWorkerRows(deriveTaskState(card('AC-20'), two))).toBeNull();
    });

    it('is the one worker who has a sentence', () => {
      const ctx = contextWith([{ handle: 'be-1', taskKey: 'AC-20', since: early, doing: gateway }]);
      const rows = cardWorkerRows(deriveTaskState(card('AC-20'), ctx))!;
      expect(rows.rows.map((row) => row.member.handle)).toEqual(['be-1']);
      expect(rows.more).toBe(0);
    });

    it('gives each of two workers a row, in the order of the card, one of them without a sentence', () => {
      const ctx = contextWith([
        { handle: 'fe-1', taskKey: 'AC-20', since: early, doing: diff },
        { handle: 'be-1', taskKey: 'AC-20', since: late },
      ]);
      const rows = cardWorkerRows(deriveTaskState(card('AC-20'), ctx))!;
      // The assignee of AC-20 comes first, whoever began first.
      expect(rows.rows.map((row) => [row.member.handle, row.doing])).toEqual([
        ['be-1', null],
        ['fe-1', diff],
      ]);
      expect(rows.more).toBe(0);
    });

    it('shows two rows and counts the rest from three workers on', () => {
      const ctx = contextWith([
        { handle: 'be-1', taskKey: 'AC-20', since: early, doing: gateway },
        { handle: 'fe-1', taskKey: 'AC-20', since: mid },
        { handle: 'dev-1', taskKey: 'AC-20', since: late, doing: diff },
      ]);
      const rows = cardWorkerRows(deriveTaskState(card('AC-20'), ctx))!;
      expect(rows.rows.map((row) => row.member.handle)).toEqual(['be-1', 'fe-1']);
      expect(rows.more).toBe(1);
    });
  });
});

describe('the cards of a member, for the team strip (PM-237)', () => {
  const titles = new Map([
    ['AC-20', 'Napi mentés'],
    ['AC-21', 'E-mail'],
    ['AC-22', 'Analitika'],
  ]);

  it('takes only the cards worked on, without repeats', () => {
    expect(
      workingCardKeys({
        taskWork: [
          work('be-1', 'AC-22', '2026-10-01T10:00:00.000Z'),
          { ...work('be-1', 'AC-20', '2026-10-01T10:05:00.000Z'), sessionId: 'ses_other' },
          { ...work('be-1', 'AC-22', '2026-10-01T10:06:00.000Z'), sessionId: 'ses_again' },
        ],
      }),
    ).toEqual(['AC-22', 'AC-20']);
    expect(workingCardKeys({})).toEqual([]);
    expect(
      workingCardKeys({ taskWork: [work('be-1', 'AC-22', '2026-10-01T10:00:00.000Z')] }, new Set(['AC-20'])),
    ).toEqual([]);
  });

  it('gives the key and title for one card, the keys for two, and a count from three', () => {
    expect(cardsLine(['AC-20'], titles)).toBe('AC-20 Napi mentés');
    expect(cardsLine(['AC-20', 'AC-21'], titles)).toBe('AC-20, AC-21');
    expect(cardsLine(['AC-20', 'AC-21', 'AC-22'], titles)).toBe('AC-20, AC-21 +1');
    expect(cardsLine([], titles)).toBeNull();
  });
});
