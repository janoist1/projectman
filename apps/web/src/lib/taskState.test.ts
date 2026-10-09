import { CODEX_PERMISSION_PROFILE_MIN_VERSION } from '@projectman/shared';
import type { InboxItem, MemberView, Stage, Task, WorkDoing } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import { formatStamp } from '../i18n/format';
import { buildConfig, tasks } from '../mocks/fixtures';
import { mockIndexes } from '../test/render';
import { cardsLine, workingCardKeys } from './members';
import { cardWorkerRows, deriveTaskState, groupOpenInboxByTask, startWaitingHint } from './taskState';
import type { TaskStateContext } from './taskState';

const COMMAND = 'Bash: npm test';
const base = mockIndexes();
const config = buildConfig();

describe('engine waiting cards', () => {
  const since = '2026-10-06T12:00:00.000Z';
  it('names the engine that is not connected', () => {
    const task: Task = {
      ...tasks[0]!,
      startWaiting: { reason: 'engine_offline', engine: 'eng_abcdefghijkl', since },
    };
    expect(deriveTaskState(task, contextWith([])).label).toBe(
      t('taskStatus.startWaiting.engine_offline', { engine: 'eng_abcdefghijkl' }),
    );
  });
  it('names the engine by its name when the engine list knows it', () => {
    const task: Task = {
      ...tasks[0]!,
      startWaiting: { reason: 'engine_offline', engine: 'eng_abcdefghijkl', since },
    };
    const ctx = { ...contextWith([]), engineNames: new Map([['eng_abcdefghijkl', 'Mac Studio']]) };
    expect(deriveTaskState(task, ctx).label).toBe(
      t('taskStatus.startWaiting.engine_offline', { engine: 'Mac Studio' }),
    );
  });
  it('says no engine is connected when the card names none', () => {
    const task: Task = { ...tasks[0]!, startWaiting: { reason: 'engine_offline', since } };
    expect(deriveTaskState(task, contextWith([])).label).toBe(
      t('taskStatus.startWaiting.engine_offline_none'),
    );
  });
});

describe('NanoGPT waiting cards', () => {
  it('renders an unknown quota hold without a retry timestamp', () => {
    const task: Task = {
      ...tasks[0]!,
      startWaiting: {
        reason: 'provider_rate_limited',
        provider: 'nanogpt',
        since: '2026-10-06T12:00:00.000Z',
      },
    };
    expect(deriveTaskState(task, contextWith([])).label).toBe(
      t('taskStatus.startWaiting.provider_rate_limited_unknown'),
    );
  });
  it('renders the quota wait with its retry time', () => {
    const until = '2026-10-06T12:15:00.000Z';
    const task: Task = {
      ...tasks[0]!,
      startWaiting: {
        reason: 'provider_rate_limited',
        provider: 'nanogpt',
        until,
        since: '2026-10-06T12:00:00.000Z',
      },
    };
    expect(deriveTaskState(task, contextWith([])).label).toBe(
      t('taskStatus.startWaiting.provider_rate_limited', { provider: 'NanoGPT', until: formatStamp(until) }),
    );
  });
  it('shows a Codex setup wait with a resolved minimum version in its hint', () => {
    const ctx = contextWith([]);
    const task: Task = {
      ...tasks[0]!,
      startWaiting: { reason: 'codex_setup_incomplete', provider: 'codex', since: new Date().toISOString() },
    };
    expect(deriveTaskState(task, ctx).label).toBe(t('taskStatus.startWaiting.codex_setup_incomplete'));
    const hint = startWaitingHint(task, ctx.members, 'owner');
    expect(hint).toContain(CODEX_PERMISSION_PROFILE_MIN_VERSION);
    expect(hint).not.toContain('{minCliVersion}');
  });
  it.each(['nanogpt_key_missing', 'nanogpt_setup_incomplete'] as const)(
    'renders a mock card waiting for %s',
    (reason) => {
      const ctx = contextWith([]);
      const task = {
        ...tasks[0]!,
        startWaiting: { reason, provider: 'nanogpt' as const, since: new Date().toISOString() },
      };
      expect(deriveTaskState(task, ctx).label).toBe(t(`taskStatus.startWaiting.${reason}`));
      expect(startWaitingHint(task, ctx.members, 'owner')).toBe(t(`taskStatus.startHints.${reason}`));
    },
  );
});

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
    it('comes from the role first: QA tests, a designer designs, an architect plans, an analyst analyses', () => {
      for (const [role, verb] of [
        ['qa', 'testing'],
        ['code_review', 'reviewing'],
        ['security_review', 'reviewing'],
        ['designer', 'designing'],
        ['architect', 'planning'],
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

describe('a card held at its fix round limit (PM-262)', () => {
  const held = (patch: Partial<NonNullable<Task['fixLimit']>>): Task => ({
    ...card('AC-20'),
    fixLimit: {
      phase: 'lead',
      rounds: 3,
      limit: 3,
      changeRequests: 2,
      designChangeRequests: 1,
      sendBacks: 0,
      decider: 'fe-1',
      deciders: [],
      reason: null,
      heldAt: '2026-10-01T10:00:00.000Z',
      ...patch,
    },
  });

  it('names who decides, and tells the one who decides that it is theirs', () => {
    const ctx = contextWith([{ handle: 'be-1', taskKey: 'AC-20', since: '2026-10-01T09:00:00.000Z' }]);
    const state = deriveTaskState(held({}), ctx);
    expect(state.phase).toBe('waiting');
    expect(state.label).toBe(t('taskStatus.fixLimit', { who: name(ctx, 'fe-1'), rounds: 3 }));
    expect(state.since).toBe('2026-10-01T10:00:00.000Z');

    const mine = deriveTaskState(held({}), { ...ctx, myHandle: 'fe-1' });
    expect(mine.phase).toBe('needs_you');
    expect(mine.label).toBe(t('taskStatus.fixLimitYou', { rounds: 3 }));
  });

  it('names the people when it waits for them, and asks the owner among them', () => {
    const ctx = contextWith([]);
    const state = deriveTaskState(held({ phase: 'owner', decider: null, deciders: ['owner'] }), ctx);
    expect(state.phase).toBe('needs_you');
    expect(state.label).toBe(t('taskStatus.fixLimitYou', { rounds: 3 }));
    const other = deriveTaskState(held({ phase: 'owner', decider: null, deciders: ['owner'] }), {
      ...ctx,
      myHandle: 'kata',
    });
    expect(other.phase).toBe('waiting');
    expect(other.label).toBe(t('taskStatus.fixLimit', { who: name(ctx, 'owner'), rounds: 3 }));
  });

  it('says how many rounds it took on the card of the one whose decision item is open, too', () => {
    const decision: InboxItem = {
      id: 'fictional-inbox',
      projectKey: 'AC',
      kind: 'decision',
      assignees: ['owner'],
      source: 'system',
      sessionId: null,
      taskKey: 'AC-20',
      title: 'fix_limit',
      body: null,
      payload: {
        fixLimit: {
          taskKey: 'AC-20',
          rounds: 3,
          limit: 3,
          changeRequests: 3,
          designChangeRequests: 0,
          sendBacks: 0,
          reason: 'no_ai_decider',
          decider: null,
          note: null,
        },
      },
      options: [],
      state: 'open',
      createdAt: '2026-10-01T10:00:00.000Z',
      resolution: null,
    };
    const ctx = { ...contextWith([]), openInboxByTask: groupOpenInboxByTask([decision]) };
    const state = deriveTaskState(held({ phase: 'owner', decider: null, deciders: ['owner'] }), ctx);
    expect(state.phase).toBe('needs_you');
    expect(state.label).toBe(t('taskStatus.fixLimitYou', { rounds: 3 }));
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

describe('a card that cannot be started yet (PM-291)', () => {
  /** The work stage asks for `scope-ok`; who may set it, and whether the project refines, vary per test. */
  const ctxFor = (setBy: 'anyone' | { members: string[] }, refines: boolean) => {
    const project = structuredClone(buildConfig());
    project.pipeline.labels.push({ id: 'scope-ok', name: 'Kidolgozás eldöntve', setBy });
    if (refines) project.pipeline.labels.push({ id: 'refine', name: 'Kidolgozásra vár', setBy: 'anyone' });
    project.pipeline.stages.find((stage) => stage.id === 'dev')!.gate = {
      conditions: [{ type: 'has_label', label: 'scope-ok' }],
    };
    return {
      ...contextWith([]),
      config: project,
      labels: project.pipeline.labels.map((label) => ({ ...label, holders: [] })),
    };
  };
  const queued = (labels: string[]): Task => ({ ...card('AC-24'), labels, stageId: 'ready' });

  it('says the card is not worked out in a project that refines, and is startable by nobody', () => {
    const state = deriveTaskState(queued([]), ctxFor('anyone', true));
    expect(state.label).toBe(t('taskStatus.notRefined'));
    expect(state.phase).toBe('ready');
    expect(state.startBlock).toMatchObject({ kind: 'unmet', refines: true });
  });

  it('names the label the card waits for where nothing in the project refines and no AI member sets it', () => {
    const state = deriveTaskState(queued([]), ctxFor({ members: ['owner'] }, false));
    expect(state.label).toBe(
      t('taskStatus.labelsMissing', { labels: t('taskStatus.quoted', { name: 'Kidolgozás eldöntve' }) }),
    );
    expect(state.startBlock).toMatchObject({ kind: 'unmet', refines: false });
  });

  it('asks the viewer for the step when only people set it and they are one of them', () => {
    const state = deriveTaskState(queued(['refine']), ctxFor({ members: ['owner'] }, true));
    expect(state.label).toBe(
      t('taskStatus.refinement.yourStep', { label: t('taskStatus.quoted', { name: 'Kidolgozás eldöntve' }) }),
    );
    expect(state.phase).toBe('needs_you');
    expect(state.startBlock).toMatchObject({ kind: 'refining' });
  });

  it('names the member who is on turn when an AI member sets the step', () => {
    const ctx = ctxFor({ members: ['be-1'] }, true);
    const state = deriveTaskState(queued(['refine']), ctx);
    expect(state.label).toBe(t('taskStatus.waitingOn', { who: name(ctx, 'be-1') }));
    expect(state.phase).toBe('waiting');
  });

  it('says nobody can set the step when no member may', () => {
    const state = deriveTaskState(queued(['refine']), ctxFor({ members: [] }, true));
    expect(state.label).toBe(
      t('taskStatus.refinement.nobody', { label: t('taskStatus.quoted', { name: 'Kidolgozás eldöntve' }) }),
    );
    expect(state.phase).toBe('blocked');
  });

  it('says the card moves on by itself once every step is done', () => {
    const state = deriveTaskState(queued(['refine', 'scope-ok']), ctxFor({ members: ['owner'] }, true));
    expect(state.label).toBe(t('taskStatus.refinement.moving'));
  });

  describe('an approval the card lacks in its own column', () => {
    /** The queue stage the card stands in asks for `approved`, which only people give. */
    const approvalCtx = (myHandle: string) => {
      const ctx = ctxFor('anyone', false);
      ctx.config.pipeline.labels.push({ id: 'approved', name: 'Jóváhagyva', setBy: 'humans' });
      ctx.config.pipeline.stages.find((stage) => stage.id === 'ready')!.gate = {
        conditions: [{ type: 'has_label', label: 'approved' }],
      };
      return { ...ctx, myHandle, labels: ctx.config.pipeline.labels.map((l) => ({ ...l, holders: [] })) };
    };
    const quoted = t('taskStatus.quoted', { name: 'Jóváhagyva' });

    it('asks the viewer for it when they are one of those who give it', () => {
      const state = deriveTaskState(queued(['scope-ok']), approvalCtx('owner'));
      expect(state.label).toBe(t('taskStatus.approvalMissingYou', { label: quoted }));
      expect(state.phase).toBe('needs_you');
      expect(state.startBlock).toMatchObject({ kind: 'approval', label: 'approved' });
    });

    it('only names what it waits for when the viewer is not one of them', () => {
      const state = deriveTaskState(queued(['scope-ok']), approvalCtx('be-1'));
      expect(state.label).toBe(t('taskStatus.approvalMissing', { label: quoted }));
      expect(state.phase).toBe('waiting');
    });
  });

  it('keeps the old line where the configuration is not known (a client)', () => {
    const { config: _config, ...ctx } = ctxFor('anyone', true);
    const state = deriveTaskState(queued([]), ctx);
    expect(state.startBlock).toBeUndefined();
    expect(state.label).toBe(t('taskStatus.ready'));
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
