import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '@projectman/shared';
import { t } from '../i18n/t';
import { describeEvent, shortCommit } from './timeline';

const creation: TimelineEvent = {
  id: 'fictional-event',
  projectKey: 'AC',
  taskKey: 'AC-1',
  sessionId: null,
  actor: { kind: 'human', handle: 'owner' },
  type: 'task_created',
  data: { title: 'Fictional ticket' },
  createdAt: '2024-03-12T09:15:00.000Z',
};
const context = { pipeline: null, members: new Map(), myHandle: 'owner', openInboxIds: new Set<string>() };

it('renders a PM loop assessment without exposing its private note', () => {
  const event: TimelineEvent = {
    ...creation,
    actor: { kind: 'ai', handle: 'pm' },
    type: 'loop_triaged',
    data: { loopId: 'loop_1', generation: 0, outcome: 'progress', evidenceIds: [], headCommit: null },
  };
  expect(describeEvent(event, context).text).toBe(t('timeline.events.loop_triaged'));
});

describe('merge queue timeline text (PM-576)', () => {
  it('names the cards a merge was put ahead of and the reason', () => {
    const event: TimelineEvent = {
      ...creation,
      type: 'task_merge_prioritized',
      data: { mergeId: 'm1', repo: 'web', reason: 'AC-3 depends on it', ahead: ['AC-2', 'AC-4'] },
    };
    expect(describeEvent(event, context).text).toBe(
      t('timeline.events.task_merge_prioritized_ahead', {
        ahead: 'AC-2, AC-4',
        reason: 'AC-3 depends on it',
      }),
    );
    expect(describeEvent({ ...event, data: { ...event.data, ahead: [] } }, context).text).toBe(
      t('timeline.events.task_merge_prioritized', { reason: 'AC-3 depends on it' }),
    );
  });
});

describe('creation timeline labels', () => {
  it('names previous and new priority, including setting and clearing', () => {
    for (const [previousPriority, priority] of [
      [null, 'urgent'],
      ['normal', 'high'],
      ['high', null],
    ]) {
      const name = (value: string | null | undefined) =>
        value ? t(`priority.levels.${value as 'urgent' | 'normal' | 'high'}`) : t('timeline.noPriority');
      expect(
        describeEvent(
          { ...creation, type: 'task_updated', data: { fields: ['priority'], previousPriority, priority } },
          context,
        ).text,
      ).toBe(
        t('timeline.events.task_updated', {
          fields: t('timeline.priorityChange', {
            previous: name(previousPriority),
            priority: name(priority),
          }),
        }),
      );
    }
  });
  it('describes an AI boundary decision and keeps old check events readable', () => {
    const decision = {
      ...creation,
      type: 'boundary_changed' as const,
      actor: { kind: 'ai' as const, handle: 'lead' },
      data: {
        requestId: 'bnd_fixture',
        resource: 'example.test/docs',
        state: 'allowed',
        reason: 'scope_verified',
      },
    };
    expect(describeEvent(decision, context).text).toContain(t('boundary.states.allowed'));
    expect(describeEvent(decision, context).text).toContain(t('boundary.reasons.scope_verified'));
    expect(
      describeEvent(
        { ...creation, type: 'task_check_changed', data: { check: 'code_review', to: 'passed' } },
        context,
      ).text,
    ).toContain(t('timeline.legacyChecks.states.passed'));
  });
  it('distinguishes imported history from normal creation', () => {
    expect(describeEvent(creation, context).text).toBe(t('timeline.events.task_created'));
    expect(describeEvent({ ...creation, data: { ...creation.data, imported: true } }, context).text).toBe(
      t('timeline.events.task_created_imported'),
    );
  });
});

it.each(['allow', 'deny'] as const)('describes automatic permission %s on the timeline', (decision) => {
  const event: TimelineEvent = {
    ...creation,
    type: 'permission_resolved',
    actor: { kind: 'system', handle: null },
    data: { decision, inboxItemId: 'fictional-inbox' },
  };
  expect(describeEvent(event, context).text).toBe(t(`timeline.events.permission_automatic_${decision}`));
});

it.each([
  ['allow', 'allowed'],
  ['deny', 'denied'],
] as const)('says an AI decider answered a permission request: %s', (decision, word) => {
  const event: TimelineEvent = {
    ...creation,
    type: 'permission_resolved',
    actor: { kind: 'ai', handle: 'lead' },
    data: { decision, inboxItemId: 'fictional-inbox' },
  };
  expect(describeEvent(event, context).text).toBe(t(`timeline.events.permission_ai_${word}`));
});

it.each([
  ['approver_none', 'permission_refused_approver_none'],
  ['classifier', 'permission_refused_classifier'],
] as const)('describes a refused permission request (by %s) with the reason folded away', (by, key) => {
  const event: TimelineEvent = {
    ...creation,
    type: 'permission_refused',
    actor: { kind: 'ai', handle: 'dev' },
    data: { toolName: 'Bash', summary: 'curl example.test', by, reason: 'Not allowed here' },
  };
  expect(describeEvent(event, context)).toMatchObject({
    text: t(`timeline.events.${key}`, { summary: 'curl example.test' }),
    emphasis: 'normal',
    detail: 'Not allowed here',
  });
  expect(describeEvent({ ...event, data: { ...event.data, reason: undefined } }, context).detail).toBe(
    undefined,
  );
});

it('describes an owner changing a session’s permission settings, from what to what (PM-170)', () => {
  const event = (data: Record<string, unknown>): TimelineEvent => ({
    ...creation,
    type: 'session_permission_changed',
    actor: { kind: 'human', handle: 'owner' },
    data: { member: 'dev', ...data },
  });
  const mode = t('timeline.events.session_permission_mode', {
    member: 'dev',
    from: t('permissionModes.auto'),
    to: t('permissionModes.plan'),
  });
  expect(describeEvent(event({ field: 'mode', from: 'auto', to: 'plan', restart: true }), context).text).toBe(
    t('timeline.events.session_permission_restart', { change: mode }),
  );
  const approver = t('timeline.events.session_permission_approver', {
    member: 'dev',
    from: t('permissionControls.approvers.none'),
    to: t('permissionControls.approvers.human'),
  });
  expect(
    describeEvent(event({ field: 'approver', from: 'none', to: 'human', reset: true }), context).text,
  ).toBe(t('timeline.events.session_permission_reset', { change: approver }));
});

it('shows the AI decider reason as a detail, and an escalation to a person', () => {
  const resolved: TimelineEvent = {
    ...creation,
    type: 'permission_resolved',
    actor: { kind: 'ai', handle: 'lead' },
    data: { decision: 'deny', inboxItemId: 'inb', delegated: true, reason: 'Unsafe target' },
  };
  expect(describeEvent(resolved, context)).toMatchObject({
    text: t('timeline.events.permission_ai_denied'),
    detail: 'Unsafe target',
  });
  const escalated: TimelineEvent = {
    ...creation,
    type: 'permission_escalated',
    actor: { kind: 'ai', handle: 'lead' },
    data: { inboxItemId: 'inb', cause: 'lead', assignees: ['owner'], reason: 'Needs the owner' },
  };
  expect(describeEvent(escalated, context)).toMatchObject({
    text: t('timeline.events.permission_escalated_lead'),
    emphasis: 'normal',
    detail: 'Needs the owner',
  });
  const open = { ...context, openInboxIds: new Set(['inb']) };
  expect(
    describeEvent(
      {
        ...escalated,
        actor: { kind: 'system', handle: null },
        data: { ...escalated.data, cause: 'timeout' },
      },
      open,
    ),
  ).toMatchObject({ text: t('timeline.events.permission_escalated_timeout'), emphasis: 'needs' });
  for (const cause of ['undelivered', 'unavailable'] as const)
    expect(
      describeEvent(
        {
          ...escalated,
          actor: { kind: 'system', handle: null },
          data: { ...escalated.data, cause },
        },
        open,
      ),
    ).toMatchObject({ text: t('timeline.events.permission_escalated_unreached'), emphasis: 'needs' });
});

it('describes checks recorded before labels replaced them', () => {
  const event: TimelineEvent = {
    ...creation,
    type: 'task_check_changed',
    data: { check: 'qa', from: 'pending', to: 'retest_needed' },
  };
  expect(describeEvent(event, context).text).toBe(
    t('timeline.events.task_check_changed', {
      check: t('timeline.legacyChecks.names.qa'),
      state: t('timeline.legacyChecks.states.retest_needed'),
    }),
  );
});

describe('themes on the timeline (PM-192)', () => {
  const theme = (themeKey: string | null, previous: string | null) =>
    describeEvent({ ...creation, type: 'task_theme_changed', data: { themeKey, previous } }, context).text;

  it('words putting a card into a theme, moving it between themes and taking it out', () => {
    expect(theme('AC-9', null)).toBe('Téma beállítva: AC-9');
    expect(theme('AC-9', 'AC-8')).toBe('Téma módosítva: AC-8 → AC-9');
    expect(theme(null, 'AC-8')).toBe('Téma eltávolítva: AC-8');
  });

  it('words the closing of a theme, apart from the cancelling of a card', () => {
    expect(
      describeEvent(
        { ...creation, type: 'task_updated', data: { action: 'closed', fields: ['status', 'closedAt'] } },
        context,
      ).text,
    ).toBe('Lezárta a témát.');
  });
});

describe('parts left after a breakdown on the timeline (PM-480)', () => {
  const left = (phase: string) =>
    describeEvent(
      { ...creation, type: 'task_parts_left', data: { phase, member: 'dev-1', parts: ['AC-2', 'AC-3'] } },
      context,
    ).text;

  it('says the member was reminded, and later that the owner was told', () => {
    expect(left('told')).toBe(t('timeline.events.parts_left_told', { name: 'dev-1', parts: 'AC-2, AC-3' }));
    expect(left('alerted')).toBe(
      t('timeline.events.parts_left_alerted', { name: 'dev-1', parts: 'AC-2, AC-3' }),
    );
  });
});

describe('open-step reminders on the timeline (PM-806)', () => {
  const row = (type: 'obligation_woken' | 'obligation_handed_over', data: Record<string, unknown>) =>
    describeEvent({ ...creation, actor: { kind: 'system', handle: null }, type, data }, context).text;

  it('names the responsible, the step and the minutes', () => {
    const data = { kind: 'merge', responsible: 'dev-1', minutes: 30 };
    expect(row('obligation_woken', data)).toBe(
      t('timeline.events.obligation_woken', { responsible: 'dev-1', step: 'beolvasztás', minutes: 30 }),
    );
    expect(row('obligation_handed_over', data)).toBe(
      t('timeline.events.obligation_handed_over', { responsible: 'dev-1', step: 'beolvasztás', minutes: 30 }),
    );
  });

  it('calls a step kind this build does not know a step', () => {
    expect(row('obligation_woken', { kind: 'other', responsible: 'dev-1', minutes: 5 })).toContain('lépés');
  });

  it('shows why the obligation todo went to the owner', () => {
    expect(
      row('obligation_handed_over', {
        kind: 'start',
        responsible: 'dev-1',
        minutes: 30,
        recipient: 'owner',
        recipientRefusal: 'integrator_unavailable',
      }),
    ).toBe(
      t('timeline.events.obligation_handed_over_refused', {
        responsible: 'dev-1',
        step: 'indítás',
        minutes: 30,
        reason: 'integrator_unavailable',
      }),
    );
  });
});

describe('a released workspace on the timeline (PM-935)', () => {
  it('shows the reason the owner gave', () => {
    const data = { scopeId: 'scp_1', sessionId: 'ses_1', workspaceIds: ['mws_1'], reason: 'Checked by hand' };
    expect(describeEvent({ ...creation, type: 'workspace_released', data }, context).text).toBe(
      t('timeline.events.workspace_released', { reason: 'Checked by hand' }),
    );
  });
});

describe('card relations on the timeline (PM-192)', () => {
  const relation = (type: 'task_relation_added' | 'task_relation_removed', kind: string, ref: string) =>
    describeEvent({ ...creation, type, data: { kind, ref } }, context).text;

  it('names the relation from the side of the card the timeline belongs to', () => {
    expect(relation('task_relation_added', 'prerequisite', 'AC-5')).toBe(
      'Kapcsolat hozzáadva: Előtte kell · AC-5',
    );
    expect(relation('task_relation_added', 'prerequisite_of', 'AC-6')).toBe(
      'Kapcsolat hozzáadva: Utána jön · AC-6',
    );
    expect(relation('task_relation_removed', 'duplicated_by', 'AC-7')).toBe(
      'Kapcsolat törölve: Duplikátumai · AC-7',
    );
    expect(relation('task_relation_added', 'related', 'AC-8')).toBe(
      'Kapcsolat hozzáadva: Kapcsolódik · AC-8',
    );
    expect(relation('task_relation_added', 'duplicate_of', 'AC-9')).toBe(
      'Kapcsolat hozzáadva: Duplikátuma · AC-9',
    );
  });

  it('shows a kind this build does not know as it is', () => {
    expect(relation('task_relation_added', 'blocks', 'AC-5')).toBe('Kapcsolat hozzáadva: blocks · AC-5');
  });

  it('says that a card was closed as a duplicate, and keeps the old events as they were', () => {
    const cancelled = (data: Record<string, unknown>) =>
      describeEvent({ ...creation, type: 'task_updated', data: { action: 'cancelled', ...data } }, context)
        .text;
    expect(cancelled({ reason: 'duplicate of AC-3', duplicateOf: 'AC-3' })).toBe(
      'Lezárta duplikátumként: AC-3',
    );
    expect(cancelled({ reason: 'No longer needed' })).toBe(
      t('timeline.events.task_cancelled_reason', { reason: 'No longer needed' }),
    );
    // The earlier prerequisite link event still reads as it did.
    expect(
      describeEvent(
        { ...creation, type: 'task_link_added', data: { kind: 'prerequisite', ref: 'AC-17' } },
        context,
      ).text,
    ).toBe(t('timeline.events.task_link_added', { link: 'Előfeltétel: AC-17' }));
  });
});

describe('repository changes on the timeline', () => {
  const updated = (data: Record<string, unknown>): TimelineEvent => ({
    ...creation,
    type: 'task_updated',
    data,
  });
  const text = (data: Record<string, unknown>) => describeEvent(updated(data), context).text;

  it('names the repositories a change went from and to', () => {
    expect(text({ fields: ['repo'], repo: 'admin', previousRepo: 'infra' })).toBe(
      t('timeline.events.task_updated', {
        fields: t('timeline.repoChange', { previous: 'infra', repo: 'admin' }),
      }),
    );
    // A task that had or has none says so.
    expect(text({ fields: ['repo'], repo: 'admin', previousRepo: null })).toBe(
      t('timeline.events.task_updated', {
        fields: t('timeline.repoChange', { previous: t('timeline.noRepo'), repo: 'admin' }),
      }),
    );
    expect(text({ fields: ['repo'], repo: null, previousRepo: 'admin' })).toBe(
      t('timeline.events.task_updated', {
        fields: t('timeline.repoChange', { previous: 'admin', repo: t('timeline.noRepo') }),
      }),
    );
  });

  it('lists a repository change among the other fields of the update', () => {
    expect(text({ fields: ['title', 'repo'], repo: 'admin', previousRepo: null })).toBe(
      t('timeline.events.task_updated', {
        fields: [
          t('timeline.fields.title'),
          t('timeline.repoChange', { previous: t('timeline.noRepo'), repo: 'admin' }),
        ].join(t('common.listSeparator')),
      }),
    );
  });

  it('names only the field when the event does not say what it changed to', () => {
    expect(text({ fields: ['repo'] })).toBe(
      t('timeline.events.task_updated', { fields: t('timeline.fields.repo') }),
    );
  });
});

describe('the hand-on request on the timeline (PM-461)', () => {
  it('says who finished, who takes the card on and where it goes', () => {
    const event: TimelineEvent = {
      ...creation,
      type: 'task_hand_on_requested',
      actor: { kind: 'system', handle: null },
      data: { fromStageId: 'dev', toStageId: 'review', mover: 'kata', requestedBy: 'be-1' },
    };
    const { text } = describeEvent(event, context);
    expect(text).toBe('be-1 végzett; kata viszi tovább ide: review');
    expect(text).toBe(
      t('timeline.events.task_hand_on_requested', { requestedBy: 'be-1', mover: 'kata', to: 'review' }),
    );
  });
});

describe('review pins on the timeline (PM-183)', () => {
  const move = (data: Record<string, unknown>): TimelineEvent => ({
    ...creation,
    type: 'task_stage_changed',
    data: { from: 'dev', to: 'review', ...data },
  });
  const commitA = 'a'.repeat(40);
  const commitB = 'b'.repeat(40);

  it('names the commit handed over with a move, and the commits of a send-back', () => {
    expect(describeEvent(move({}), context).text).toBe(
      t('timeline.events.task_stage_changed', { from: 'dev', to: 'review' }),
    );
    expect(describeEvent(move({ reviewPin: { commit: commitA, branch: 'b' } }), context).text).toBe(
      t('timeline.events.task_stage_changed_pinned', {
        from: 'dev',
        to: 'review',
        commit: shortCommit(commitA),
      }),
    );
    expect(
      describeEvent(move({ branchMoved: { branch: 'b', pinned: commitA, head: commitB } }), context).text,
    ).toBe(
      t('timeline.events.task_stage_changed_branch_moved', {
        from: 'dev',
        to: 'review',
        pinned: shortCommit(commitA),
        head: shortCommit(commitB),
      }) +
        '. ' +
        t('fixLimit.events.notCounted'),
    );
  });

  it('says a collecting card went on without the gates because its parts closed (PM-647)', () => {
    expect(
      describeEvent(move({ partsClosed: { done: ['AC-2', 'AC-4'], cancelled: ['AC-3'] } }), context).text,
    ).toBe(
      t('timeline.events.task_stage_changed_parts_closed', {
        from: 'dev',
        to: 'review',
        parts: 'AC-2, AC-4, AC-3',
      }),
    );
  });

  it('describes a send-back after a failed full test and the full test results (PM-217)', () => {
    expect(
      describeEvent(move({ testsFailed: { runId: 'ftr_1', branch: 'b', commit: commitA } }), context).text,
    ).toBe(
      t('timeline.events.task_stage_changed_tests_failed', {
        from: 'dev',
        to: 'review',
        commit: shortCommit(commitA),
      }),
    );
    const result = (data: Record<string, unknown>): TimelineEvent => ({
      ...creation,
      type: 'task_full_test',
      data: { runId: 'ftr_1', repo: 'web', branch: 'b', commit: commitA, ...data },
    });
    const commit = shortCommit(commitA);
    expect(describeEvent(result({ outcome: 'passed' }), context).text).toBe(
      t('timeline.events.task_full_test_passed', { commit }),
    );
    expect(describeEvent(result({ outcome: 'failed', failedFiles: [] }), context).text).toBe(
      t('timeline.events.task_full_test_failed', { commit }),
    );
    expect(
      describeEvent(result({ outcome: 'failed', failedFiles: ['a.test.ts', 'b.test.ts'] }), context).text,
    ).toBe(t('timeline.events.task_full_test_failed_files', { commit, files: 'a.test.ts, b.test.ts' }));
    expect(describeEvent(result({ outcome: 'error', reason: 'timeout' }), context).text).toBe(
      t('timeline.events.task_full_test_error', {
        commit,
        reason: t('timeline.events.task_full_test_reason.timeout'),
      }),
    );
    // The output of a run that failed or could not run is folded behind "Részletek"; a green run has none.
    expect(describeEvent(result({ outcome: 'failed', outputTail: 'Failed Tests 1' }), context).detail).toBe(
      'Failed Tests 1',
    );
    expect(
      describeEvent(result({ outcome: 'error', reason: 'timeout', outputTail: 'slow' }), context).detail,
    ).toBe('slow');
    expect(describeEvent(result({ outcome: 'failed' }), context).detail).toBeUndefined();
    expect(describeEvent(result({ outcome: 'passed' }), context).detail).toBeUndefined();
  });

  it('describes a new review round of the developer that pins the new head', () => {
    const event: TimelineEvent = {
      ...creation,
      type: 'task_updated',
      data: { fields: ['reviewPin'], reviewPin: { commit: commitB, branch: 'b', previous: commitA } },
    };
    expect(describeEvent(event, context).text).toBe(
      t('timeline.events.review_repinned', { previous: shortCommit(commitA), commit: shortCommit(commitB) }),
    );
  });
});

describe('the refinement line', () => {
  const labels = [{ id: 'scope-ok', name: 'Követelmény kész', setBy: 'anyone' as const, holders: [] }];
  const turn = (data: { label: string | null; member: string | null; reason: string }): TimelineEvent =>
    ({ ...creation, type: 'refinement_turn', data }) as TimelineEvent;
  const text = (event: TimelineEvent) => describeEvent(event, { ...context, labels }).text;

  it.each([
    ['started', 'started.member'],
    ['label_set', 'label_set.member'],
    ['label_removed', 'label_removed.member'],
  ] as const)('names the member on turn and the label, by the reason %s', (reason, key) => {
    expect(text(turn({ label: 'scope-ok', member: 'arch', reason }))).toBe(
      t(`timeline.refinement.${key}`, { member: 'arch', label: 'Követelmény kész' }),
    );
  });

  it('says a person is up when no member was started, and when the refinement is done', () => {
    expect(text(turn({ label: 'scope-ok', member: null, reason: 'label_set' }))).toBe(
      t('timeline.refinement.label_set.person', { label: 'Követelmény kész' }),
    );
    expect(text(turn({ label: null, member: null, reason: 'done' }))).toBe(t('timeline.refinement.done'));
  });

  it('says the refinement stopped before every step was done (PM-420)', () => {
    expect(text(turn({ label: null, member: null, reason: 'stopped' }))).toBe(
      t('timeline.refinement.stopped'),
    );
  });
});

describe('the loop watch on the timeline (PM-261)', () => {
  const loop = (data: Record<string, unknown>): TimelineEvent => ({
    ...creation,
    actor: { kind: 'system', handle: null },
    type: 'task_loop',
    data: { loopId: 'loop_1', ...data },
  });
  const text = (data: Record<string, unknown>) => describeEvent(loop(data), context).text;

  it('says who wrote, how much, and who was told, or that it went to people straight away', () => {
    const found = { phase: 'raised', members: ['a', 'b'], count: 6, minutes: 30 };
    expect(text({ ...found, notified: 'pm' })).toBe(
      t('loop.events.raised', { pair: 'a és b', minutes: 30, count: 6, name: 'pm' }),
    );
    expect(text({ ...found, notified: null, deciders: ['owner'] })).toBe(
      t('loop.events.raisedToPeople', { pair: 'a és b', minutes: 30, count: 6 }),
    );
  });

  it('words the escalation by its reason, the let-run decision and the end', () => {
    expect(text({ phase: 'escalated', reason: 'continued', deciders: ['owner'] })).toBe(
      t('loop.events.escalated.continued', { decides: t('loop.youDecide') }),
    );
    expect(text({ phase: 'escalated', reason: 'no_watcher', deciders: ['owner'] })).toBe(
      t('loop.events.escalated.no_watcher', { decides: t('loop.youDecide') }),
    );
    expect(text({ phase: 'let_run', by: 'owner' })).toBe(t('loop.events.let_run', { name: t('common.you') }));
    expect(text({ phase: 'ended', endReason: 'quiet' })).toBe(
      t('loop.events.ended', { reason: t('loop.endReasons.quiet') }),
    );
    expect(text({ phase: 'ended', endReason: 'stopped' })).toBe(
      t('loop.events.ended', { reason: t('loop.endReasons.stopped') }),
    );
    expect(text({ phase: 'ended', endReason: 'work' })).toBe(
      t('loop.events.ended', { reason: t('loop.endReasons.work') }),
    );
    expect(text({ phase: 'ended', endReason: 'let_run' })).toBe(
      t('loop.events.ended', { reason: t('loop.endReasons.let_run') }),
    );
  });

  it('keeps an end reason this build does not know as it is', () => {
    expect(text({ phase: 'ended', endReason: 'something_new' })).toBe(
      t('loop.events.ended', { reason: 'something_new' }),
    );
  });
});

describe('fix round limit timeline rows (PM-262)', () => {
  const fixLimit = (data: Record<string, unknown>): TimelineEvent => ({
    ...creation,
    actor: { kind: 'system', handle: null },
    type: 'task_fix_limit',
    data: { rounds: 3, limit: 3, changeRequests: 2, designChangeRequests: 1, sendBacks: 0, ...data },
  });
  const text = (data: Record<string, unknown>) => describeEvent(fixLimit(data), context).text;

  it('renders grants, assessments and the failed test subtotal from additive fields', () => {
    expect(text({ phase: 'decided', decision: 'another_round', extraRounds: 4, note: 'Small fix.' })).toBe(
      t('fixLimit.events.decidedExtra', { i: 4, note: t('fixLimit.events.note', { note: 'Small fix.' }) }),
    );
    const assessment = {
      recurrence: 'Same issue.',
      currentState: 'Almost ready.',
      recommendation: { optionId: 'replan', reason: 'Clarify scope.' },
    };
    expect(text({ phase: 'passed_on', deciders: ['owner'], assessment })).toContain(
      t('fixLimit.events.assessment', {
        recurrence: assessment.recurrence,
        currentState: assessment.currentState,
        decision: t('fixLimit.decisions.replan'),
        reason: assessment.recommendation.reason,
      }),
    );
    expect(text({ phase: 'reached', sendBacks: 2, testsFailed: 1 })).toContain(
      t('fixLimit.part.testsFailed', { count: 1 }),
    );
    expect(text({ phase: 'reached', sendBacks: 2, testsFailed: 1 })).toContain(
      t('fixLimit.part.manual', { count: 1 }),
    );
  });

  it('says what the rounds were and who decides, the lead or the people', () => {
    // Only the kinds of round that happened are named, and the limit only when it is not the rounds.
    const parts = `${t('fixLimit.part.changes', { count: 2 })}${t('common.and')}${t('fixLimit.part.design', { count: 1 })}`;
    expect(text({ phase: 'reached', decider: 'lead' })).toBe(
      t('fixLimit.events.reached', {
        rounds: 3,
        parts,
        who: t('fixLimit.events.who', { name: 'lead' }),
      }),
    );
    expect(text({ phase: 'reached', decider: 'lead', limit: 2 })).toBe(
      t('fixLimit.events.reachedLimit', {
        rounds: 3,
        limit: 2,
        parts,
        who: t('fixLimit.events.who', { name: 'lead' }),
      }),
    );
    expect(text({ phase: 'reached', decider: null, deciders: ['owner'] })).toContain('); te döntesz.');
  });

  it('words the hand-over to the people, the decision with its note and the end', () => {
    // The row's header names who did it, so the text has no name.
    expect(text({ phase: 'passed_on', decider: 'lead', deciders: ['owner'], note: 'Wrong plan' })).toBe(
      t('fixLimit.events.passed_on', {
        decides: t('loop.youDecide'),
        note: t('fixLimit.events.note', { note: 'Wrong plan' }),
      }),
    );
    expect(text({ phase: 'decided', decision: 'another_round', by: 'owner' })).toBe(
      t('fixLimit.events.decided', {
        decision: t('fixLimit.decisions.another_round'),
        note: '',
      }),
    );
    expect(text({ phase: 'ended', endReason: 'assignee_changed' })).toBe(
      t('fixLimit.events.ended', { reason: t('fixLimit.endReasons.assignee_changed') }),
    );
    expect(text({ phase: 'ended', endReason: 'something_new' })).toBe(
      t('fixLimit.events.ended', { reason: 'something_new' }),
    );
  });
});

describe('Senior timeline texts (PM-349)', () => {
  const text = (type: TimelineEvent['type'], data: Record<string, unknown>) =>
    describeEvent({ ...creation, type, data }, context).text;

  it('tells a first recommendation, a change, and the reason', () => {
    expect(text('task_level_changed', { level: 'senior', reason: 'Kényes migráció' })).toBe(
      t('timeline.levelSet', { level: t('timeline.levelSenior') }) +
        t('timeline.levelReason', { reason: 'Kényes migráció' }),
    );
    expect(text('task_level_changed', { level: 'any', previous: { level: 'senior', reason: 'x' } })).toBe(
      t('timeline.levelChanged', { previous: t('timeline.levelSenior'), level: t('timeline.levelAny') }),
    );
    // Only the reason changed: no arrow.
    expect(
      text('task_level_changed', {
        level: 'senior',
        reason: 'Új',
        previous: { level: 'senior', reason: 'Régi' },
      }),
    ).toBe(
      t('timeline.levelSet', { level: t('timeline.levelSenior') }) +
        t('timeline.levelReason', { reason: 'Új' }),
    );
  });

  it('tells the phases of the wait for the Senior, and falls back for what it does not know', () => {
    expect(text('task_senior_wait', { phase: 'asked', minutes: 30, deciders: ['owner'] })).toBe(
      t('timeline.seniorWaitAsked', { minutes: 30, names: t('common.you') }),
    );
    expect(text('task_senior_wait', { phase: 'decided', decision: 'wait', by: 'owner' })).toBe(
      t('timeline.seniorWaitDecidedWait', { name: t('common.you') }),
    );
    expect(text('task_senior_wait', { phase: 'decided', decision: 'any', by: 'owner' })).toBe(
      t('timeline.seniorWaitDecidedAny', { name: t('common.you') }),
    );
    expect(text('task_senior_wait', { phase: 'senior_took' })).toBe(t('timeline.seniorWaitTook'));
    expect(text('task_senior_wait', { phase: 'no_senior' })).toBe(t('timeline.seniorWaitNoSenior'));
    expect(text('task_senior_wait', { phase: 'something_new' })).toBe(t('timeline.seniorWaitOther'));
    expect(text('task_senior_wait', { phase: 'asked' })).toBe(t('timeline.seniorWaitOther'));
    expect(text('task_senior_wait', { phase: 'decided', decision: 'maybe', by: 'owner' })).toBe(
      t('timeline.seniorWaitOther'),
    );
  });
});

describe('the handoff rows (PM-342)', () => {
  const event = (type: TimelineEvent['type'], data: Record<string, unknown>): TimelineEvent => ({
    ...creation,
    type,
    actor: { kind: 'system', handle: null },
    data,
  });
  const handoff = (phase: string, extra: Record<string, unknown> = {}) =>
    describeEvent(
      event('task_handoff', {
        phase,
        handoffId: 'hnd_1',
        from: 'be-1',
        to: 'fe-1',
        fromProvider: 'codex',
        toProvider: 'claude',
        ...extra,
      }),
      context,
    );
  const pair = { from: 'be-1', to: 'fe-1' };

  it('words each phase, and keeps the note in full under the details', () => {
    expect(handoff('started', { mode: 'live', reason: 'manual' }).text).toBe(
      t('timeline.events.task_handoff.started', pair),
    );
    expect(handoff('started', { mode: 'live', reason: 'fix_limit_reassign' }).text).toBe(
      t('timeline.events.task_handoff.startedWith', {
        ...pair,
        reason: t('handoff.reason.fix_limit_reassign'),
      }),
    );
    expect(handoff('retargeted').text).toBe(t('timeline.events.task_handoff.retargeted', pair));
    expect(handoff('taken_over').text).toBe(t('timeline.events.task_handoff.taken_over', pair));
    expect(handoff('cancelled').text).toBe(t('timeline.events.task_handoff.cancelled', pair));

    const longNote = `${'A '.repeat(100)}\nSecond line.`;
    const described = handoff('note', { note: longNote });
    expect(described.detail).toBe(longNote);
    expect(described.text.startsWith('Átadó jegyzet → fe-1: ')).toBe(true);
    expect(described.text).not.toContain('Second line');
  });

  it('says why there was no note, with or without a summary and a receiver', () => {
    const reason = t('handoff.fallbackReason.on_leave', { from: 'be-1' });
    expect(handoff('fallback', { fallbackReason: 'on_leave', summary: true }).text).toBe(
      t('timeline.events.task_handoff.fallback', { ...pair, reason }),
    );
    expect(handoff('fallback', { fallbackReason: 'on_leave', summary: false }).text).toBe(
      t('timeline.events.task_handoff.fallbackNoSummary', { ...pair, reason }),
    );
    expect(handoff('fallback', { fallbackReason: 'on_leave', to: null }).text).toBe(
      t('timeline.events.task_handoff.fallbackNobody', { reason }),
    );
    expect(handoff('fallback', { fallbackReason: 'something_new' }).text).toContain(
      t('handoff.fallbackReason.unknown'),
    );
  });

  it('words a conversation that started anew', () => {
    const restarted = (data: Record<string, unknown>) =>
      describeEvent(
        event('session_conversation_restarted', { member: 'fe-1', summary: true, ...data }),
        context,
      ).text;
    expect(restarted({ reason: 'provider_changed', fromProvider: 'codex', toProvider: 'claude' })).toBe(
      t('timeline.events.session_conversation_restarted.providerShift', {
        fromProvider: t('providers.codex'),
        toProvider: t('providers.claude'),
        member: 'fe-1',
      }),
    );
    expect(
      restarted({ reason: 'provider_changed', fromProvider: 'codex', toProvider: 'claude', summary: false }),
    ).toBe(
      t('timeline.events.session_conversation_restarted.providerShiftNoSummary', {
        fromProvider: t('providers.codex'),
        toProvider: t('providers.claude'),
        member: 'fe-1',
      }),
    );
    expect(restarted({ reason: 'lost' })).toBe(
      t('timeline.events.session_conversation_restarted.lost', { member: 'fe-1' }),
    );
    expect(restarted({ reason: 'lost', lastHandoffId: 'hnd_1' })).toBe(
      t('timeline.events.session_conversation_restarted.lostNote', { member: 'fe-1' }),
    );
  });
});

describe('the merge event with a fixed conflict (PM-471)', () => {
  const merged = (data: Record<string, unknown>) =>
    describeEvent(
      {
        ...creation,
        type: 'task_merged',
        data: { base: 'main', commit: 'a'.repeat(40), mergeCommit: 'b'.repeat(40), via: 'tool', ...data },
      },
      context,
    );

  it('keeps what the merger wrote about the conflict for its own fold', () => {
    const note = 'Kept both imports in **board.ts**.';
    expect(merged({ resolution: { note, commit: 'c'.repeat(40) } }).resolution).toBe(note);
  });

  it('has no resolution when there is none or it is blank', () => {
    expect(merged({}).resolution).toBeUndefined();
    expect(merged({ resolution: { note: '  ', commit: 'c' } }).resolution).toBeUndefined();
  });
});

describe('the rows of a question the Operator screens (PM-556)', () => {
  const row = (type: TimelineEvent['type'], data: Record<string, unknown>) =>
    describeEvent({ ...creation, type, actor: { kind: 'system', handle: null }, data }, context).text;
  const asker = 'dev-1';

  it('distinguishes integrator screening, own results and a system handoff from historical owner answers', () => {
    expect(
      row('question_screened', {
        inboxItemId: 'inb_1',
        asker,
        note: 'Measure',
        outcome: 'todo',
        recipient: 'integrator',
      }),
    ).toBe(t('timeline.events.question_screened_integrator', { note: 'Measure' }));
    expect(
      row('question_answered', {
        inboxItemId: 'inb_1',
        answer: 'Done',
        integratorTodo: { optionId: 'todo_done', note: null },
      }),
    ).toBe(t('timeline.events.integrator_todo_done'));
    expect(
      row('question_answered', {
        inboxItemId: 'inb_1',
        answer: 'Cannot',
        integratorTodo: { optionId: 'todo_cannot', note: 'No access' },
      }),
    ).toBe(t('timeline.events.integrator_todo_cannot', { note: 'No access' }));
    expect(row('question_recipient_escalated', {})).toBe(t('timeline.events.question_recipient_escalated'));
  });

  it('words each outcome of the screening', () => {
    const base = { inboxItemId: 'inb_1', asker, note: 'It is clear.' };
    expect(row('question_screened', { ...base, outcome: 'answered', answer: 'Yes' })).toBe(
      t('timeline.events.question_screened_answered', { asker: 'dev-1', answer: 'Yes' }),
    );
    expect(row('question_screened', { ...base, outcome: 'forwarded', forwardedTo: 'dev-2' })).toBe(
      t('timeline.events.question_screened_forwarded', { asker: 'dev-1', to: 'dev-2', note: base.note }),
    );
    expect(row('question_screened', { ...base, outcome: 'moot' })).toBe(
      t('timeline.events.question_screened_moot', { asker: 'dev-1', note: base.note }),
    );
    expect(row('question_screened', { ...base, outcome: 'decision' })).toBe(
      t('timeline.events.question_screened_decision', { note: base.note }),
    );
    expect(row('question_screened', { ...base, outcome: 'todo' })).toBe(
      t('timeline.events.question_screened_todo', { note: base.note }),
    );
  });

  it('says when a question goes to the Operator first, and why one skips the screening', () => {
    const base = { inboxItemId: 'inb_1', question: 'Which font?' };
    expect(row('question_asked', base)).toBe(
      t('timeline.events.question_asked', { question: 'Which font?' }),
    );
    expect(row('question_asked', { ...base, screening: true })).toBe(
      t('timeline.events.question_asked_screening', { question: 'Which font?' }),
    );
    expect(
      row('question_asked', {
        ...base,
        unscreened: { reason: 'It needs a person', previousItemId: 'inb_0' },
      }),
    ).toBe(
      t('timeline.events.question_asked_unscreened', {
        question: 'Which font?',
        reason: 'It needs a person',
      }),
    );
  });

  it('says a todo was recorded as a missing feature only when it was', () => {
    const base = { inboxItemId: 'inb_1', asker, note: 'Needs a key.', outcome: 'todo' };
    expect(row('question_screened', { ...base, feedbackId: 'fb_1' })).toBe(
      t('timeline.events.question_screened_todo_recorded', { note: base.note }),
    );
    expect(row('question_screened', base)).toBe(
      t('timeline.events.question_screened_todo', { note: base.note }),
    );
  });

  it('words the fallback, the closing and the answer delivery', () => {
    expect(row('question_screening_skipped', { inboxItemId: 'inb_1', asker, reason: 'timeout' })).toBe(
      t('timeline.events.question_screening_skipped_timeout', { asker: 'dev-1' }),
    );
    expect(row('question_screening_skipped', { inboxItemId: 'inb_1', asker, reason: 'unavailable' })).toBe(
      t('timeline.events.question_screening_skipped_unavailable', { asker: 'dev-1' }),
    );
    expect(row('question_closed', { inboxItemId: 'inb_1', asker, rule: 'task_done', note: null })).toBe(
      t('timeline.events.question_closed', { asker: 'dev-1', reason: t('inbox.resolutions.task_done') }),
    );
    expect(
      row('question_closed', { inboxItemId: 'inb_1', asker, rule: 'withdrawn', note: 'Never mind' }),
    ).toBe(t('timeline.events.question_closed_withdrawn', { asker: 'dev-1', note: 'Never mind' }));
    expect(row('question_answer_delivery', { inboxItemId: 'inb_1', asker, state: 'waiting' })).toBe(
      t('timeline.events.question_answer_waiting', { asker: 'dev-1' }),
    );
    expect(row('question_answer_delivery', { inboxItemId: 'inb_1', asker, state: 'delivered' })).toBe(
      t('timeline.events.question_answer_delivered'),
    );
  });
});
