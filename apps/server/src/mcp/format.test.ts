import type { TaskRelation, TimelineEvent } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import {
  formatQuestionAsked,
  formatSentMessage,
  formatTaskCreated,
  formatTaskDetail,
  formatTaskUpdate,
  questionHint,
} from './format';
import { sampleTaskDetail } from './testing';

function note(minute: number, text: string): TimelineEvent {
  return {
    id: `evt_note_${minute}`,
    projectKey: 'AR',
    taskKey: 'AR-21',
    sessionId: null,
    actor: { kind: 'ai', handle: 'qa' },
    type: 'task_note',
    data: { text },
    createdAt: `2026-09-29T11:${String(minute).padStart(2, '0')}:00.000Z`,
  };
}

describe('formatTaskDetail', () => {
  it('shows the open handoff of the card, else the latest one that ended (PM-342)', () => {
    const lineOf = (detail: Parameters<typeof formatTaskDetail>[0]) =>
      formatTaskDetail(detail)
        .split('\n')
        .find((line) => line.startsWith('Handoff: ') || line.startsWith('Latest handoff: '));
    const detail = sampleTaskDetail();
    expect(lineOf(detail)).toBeUndefined();

    detail.task.handoff = {
      id: 'hof_1',
      from: 'dev-1',
      to: 'dev-2',
      fromProvider: 'claude',
      toProvider: 'claude',
      reason: 'manual',
      step: 'writing',
      startedAt: '2026-10-05T08:00:00.000Z',
      deadlineAt: '2026-10-05T08:10:00.000Z',
    };
    expect(lineOf(detail)).toMatch(
      /^Handoff: dev-1 → dev-2 in progress \(writing, the note is due by .+\)\./,
    );

    detail.task.handoff = {
      ...detail.task.handoff,
      step: 'closing',
      deadlineAt: null,
      fallbackReason: 'on_leave',
    };
    expect(lineOf(detail)).toContain('no note (on_leave): a summary stands in');

    delete detail.task.handoff;
    detail.task.lastHandoff = {
      id: 'hof_1',
      from: 'dev-1',
      to: 'dev-2',
      fromProvider: 'claude',
      toProvider: 'claude',
      outcome: 'fallback',
      fallbackReason: 'timeout',
      endedAt: '2026-10-05T08:10:00.000Z',
    };
    expect(lineOf(detail)).toMatch(/^Latest handoff: dev-1 → dev-2 with a summary \(timeout\), ended /);
  });

  it('names the repository the work happens in, not only the task’s own', () => {
    const repoLine = (detail: Parameters<typeof formatTaskDetail>[0]) =>
      formatTaskDetail(detail)
        .split('\n')
        .find((line) => line.startsWith('Repo: '));
    const detail = sampleTaskDetail();
    detail.task.repo = null;
    // A handler that does not say falls back to the task's own repository.
    expect(repoLine(detail)).toBe('Repo: the workspace root · Visibility: internal · Priority: high');
    // A task of a one-repository project works in that repository.
    expect(repoLine({ ...detail, effectiveRepo: 'web', repoChoiceNeeded: false })).toBe(
      'Repo: web · Visibility: internal · Priority: high',
    );
    // Several repositories and none chosen: the agent is told why there is none.
    expect(repoLine({ ...detail, effectiveRepo: null, repoChoiceNeeded: true })).toBe(
      'Repo: none chosen yet (the project has several repositories; ask a human which one if you need to know) · ' +
        'Visibility: internal · Priority: high',
    );
    // No repositories at all: the workspace root.
    expect(repoLine({ ...detail, effectiveRepo: null, repoChoiceNeeded: false })).toBe(
      'Repo: the workspace root · Visibility: internal · Priority: high',
    );
  });

  it('shows the place in the project focus after the priority, and no line without one (PM-437)', () => {
    const detail = sampleTaskDetail();
    expect(formatTaskDetail(detail)).not.toContain('Focus:');
    const lines = formatTaskDetail({ ...detail, focus: { position: 2, via: 'AR-30' } }).split('\n');
    const priority = lines.findIndex((line) => line.includes('Priority: '));
    expect(lines[priority + 1]).toBe('Focus: place 2 (via AR-30)');
    expect(formatTaskDetail({ ...detail, focus: { position: 1 } })).toContain('\nFocus: place 1\n');
  });

  it('lists the relations to other cards by kind, and keeps them out of the links (PM-192)', () => {
    const detail = sampleTaskDetail();
    detail.task.links = [
      { kind: 'branch', ref: 'ar-21-login-validation', repo: 'web' },
      { kind: 'prerequisite', ref: 'AR-19' },
      { kind: 'related', ref: 'AR-30' },
    ];
    const card = (key: string, kind: TaskRelation['kind']): TaskRelation => ({
      kind,
      key,
      title: `Title ${key}`,
      stageId: 'qa',
      status: 'active',
    });
    const out = formatTaskDetail({
      ...detail,
      relations: [card('AR-19', 'prerequisite'), card('AR-30', 'related'), card('AR-31', 'duplicated_by')],
    });
    expect(out).toContain('Links: Branch: ar-21-login-validation in web\n');
    expect(out).toContain(
      [
        'Relations:',
        'This card needs first (prerequisite):',
        '- AR-19 "Title AR-19" · Stage: qa · Status: active',
        'This card is related to:',
        '- AR-30 "Title AR-30" · Stage: qa · Status: active',
        'This card has as duplicates:',
        '- AR-31 "Title AR-31" · Stage: qa · Status: active',
      ].join('\n'),
    );
    expect(formatTaskDetail(detail)).not.toContain('Relations:');
  });

  it('does not list the parent and the subtasks twice', () => {
    const detail = sampleTaskDetail();
    const card = (key: string, kind: TaskRelation['kind']): TaskRelation => ({
      kind,
      key,
      title: `Title ${key}`,
      stageId: 'dev',
      status: 'active',
    });
    const out = formatTaskDetail({
      ...detail,
      parent: { ...detail.task, key: 'AR-1', title: 'The parent' },
      subtasks: [{ ...detail.task, key: 'AR-2', title: 'A part' }],
      relations: [card('AR-1', 'part_of'), card('AR-2', 'has_part')],
    });
    expect(out).toContain('Parent: AR-1 — The parent');
    expect(out).toContain('Subtasks:\n- AR-2 — A part');
    expect(out).not.toContain('Relations:');
  });

  it('words the relation events of both cards', () => {
    const detail = sampleTaskDetail();
    const event = (type: TimelineEvent['type'], data: Record<string, unknown>, minute: number) => ({
      ...note(minute, ''),
      type,
      data,
    });
    detail.timeline = [
      event('task_relation_added', { kind: 'prerequisite_of', ref: 'AR-22' }, 0),
      event('task_relation_removed', { kind: 'duplicated_by', ref: 'AR-23' }, 1),
    ];
    const out = formatTaskDetail(detail);
    expect(out).toContain('qa: added the relation: this card is the prerequisite of AR-22');
    expect(out).toContain('qa: removed the relation: this card has as duplicates AR-23');
  });

  it('names who works on the card now, the other sessions and the questions asked on it (PM-249)', () => {
    const detail = sampleTaskDetail();
    const session = (id: string, member: string, state: 'working' | 'idle' | 'waiting_input' | 'exited') => ({
      ...detail.sessions[0]!,
      id,
      member,
      state,
    });
    detail.sessions = [
      session('ses_a', 'designer', 'working'),
      session('ses_b', 'fe-1', 'waiting_input'),
      session('ses_c', 'analyst', 'idle'),
    ];
    const out = formatTaskDetail({
      ...detail,
      workingSessionIds: ['ses_a', 'ses_b'],
      cardQuestions: [
        {
          inboxItemId: 'inb_1',
          asker: 'analyst',
          question: 'Which export format?',
          askedAt: '2026-10-03T11:20:00.000Z',
          askedEventId: 'evt_q1',
          state: 'answered',
          answer: { by: 'owner', text: 'CSV', at: '2026-10-03T12:00:00.000Z', eventId: 'evt_a1' },
        },
        {
          inboxItemId: 'inb_2',
          asker: 'designer',
          question: 'x'.repeat(300),
          askedAt: '2026-10-03T11:54:00.000Z',
          askedEventId: 'evt_q2',
          state: 'open',
        },
      ],
    });
    expect(out).toContain(
      '\nWorking on it now: designer (working), fe-1 (waiting input)\nOther sessions: analyst (idle)\n',
    );
    expect(out).not.toContain('Sessions: designer');
    expect(out).toContain(
      [
        'Questions to people on this card:',
        '- analyst asked (2026-10-03 11:20 UTC): "Which export format?" → owner answered: "CSV"',
        `- designer asked (2026-10-03 11:54 UTC): "${'x'.repeat(159)}… (read it whole: get_task task_key AR-21, event_id evt_q2)" → open`,
      ].join('\n'),
    );
    // Nothing on the card: none of the lines.
    const quiet = formatTaskDetail({ ...detail, sessions: [], workingSessionIds: [], cardQuestions: [] });
    expect(quiet).not.toMatch(/Working on it now|Other sessions|Questions to people/);
  });

  it('preserves the worker line and its session-id source while adding permission deciders', () => {
    const detail = sampleTaskDetail();
    detail.sessions = [
      { ...detail.sessions[0]!, id: 'ses_dev', member: 'fe-1', state: 'working' },
      { ...detail.sessions[0]!, id: 'ses_review', member: 'qa', state: 'waiting_permission' },
    ];
    const permission = {
      inboxItemId: 'inb_1',
      deciders: ['owner', 'lead'],
      since: '2026-10-05T21:30:00.000Z',
    };
    const out = formatTaskDetail({
      ...detail,
      workingSessionIds: ['ses_dev', 'ses_review'],
      cardWorkers: [
        {
          handle: 'qa',
          displayName: 'QA',
          role: 'tester',
          state: 'waiting_permission',
          waitingPermission: permission,
        },
      ],
    });
    expect(out).toContain('Working on it now: fe-1 (working), qa (waiting permission, decides: owner, lead)');
    const quiet = formatTaskDetail({
      ...detail,
      sessions: [],
      workingSessionIds: [],
      cardWorkers: [
        {
          handle: 'qa',
          displayName: 'QA',
          role: 'tester',
          state: 'waiting_permission',
          waitingPermission: permission,
        },
      ],
    });
    expect(quiet).not.toContain('Working on it now');
  });

  it('lists the labels once, on the status line', () => {
    const detail = sampleTaskDetail();
    detail.task.labels = ['frontend', 'qa-ok'];
    const out = formatTaskDetail(detail);
    expect(out.split('\n').slice(1, 3)).toEqual([
      'Stage: dev · Status: active · Assignee: fe-1 · Labels: frontend, qa-ok',
      'Repo: web · Visibility: internal · Priority: high',
    ]);
    expect(out.match(/Labels:/g)).toHaveLength(1);
  });

  it('shows the most recent timeline events, oldest first', () => {
    const detail = sampleTaskDetail();
    // Out of order on purpose: the formatter sorts by time.
    detail.timeline = Array.from({ length: 25 }, (_, i) => note(i, `note ${i}`)).reverse();

    const out = formatTaskDetail(detail);

    expect(out).toContain('Recent timeline (last 20 of 25, oldest first):');
    expect(out).not.toContain('note 4\n');
    expect(out.indexOf('note 5')).toBeLessThan(out.indexOf('note 24'));
    expect(out.trimEnd().endsWith('- 2026-09-29 11:24 UTC · qa: note: note 24')).toBe(true);
  });

  it('tells the reader which of its messages were not delivered yet, so that it does not ask for a resend', () => {
    const message = (id: string, minute: number): TimelineEvent => ({
      ...note(minute, ''),
      id: `evt_${id}`,
      actor: { kind: 'ai', handle: 'architect' },
      type: 'team_message',
      data: { messageId: id, from: 'architect', to: ['fe-1'], excerpt: 'Please work out the plan…' },
    });
    const detail = sampleTaskDetail();
    detail.timeline = [message('msg_1', 0), message('msg_2', 1)];
    const lines = formatTaskDetail({ ...detail, undeliveredMessageIds: ['msg_2'] }).split('\n');
    expect(lines.filter((l) => l.includes('not delivered to you yet'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('Please work out the plan…'))).toHaveLength(2);
    expect(lines.at(-1)).toBe(
      '- 2026-09-29 11:01 UTC · architect: message to fe-1 [action]: Please work out the plan… ' +
        '(not delivered to you yet: the full text is typed in when your current turn ends; do not ask for a resend)',
    );
    // A handler that does not say leaves the lines as they were.
    expect(formatTaskDetail(detail)).not.toContain('not delivered');
  });

  it("marks the reader's own sent messages that are not typed in for every recipient yet (PM-144)", () => {
    const sent: TimelineEvent = {
      ...note(0, ''),
      id: 'evt_s1',
      actor: { kind: 'ai', handle: 'fe-1' },
      type: 'team_message',
      data: { messageId: 'msg_s1', from: 'fe-1', to: ['qa', 'cr'], excerpt: 'Please review…' },
    };
    const detail = sampleTaskDetail();
    detail.timeline = [sent];
    const out = formatTaskDetail({
      ...detail,
      pendingSentMessages: [{ messageId: 'msg_s1', handles: ['qa', 'cr'] }],
    });
    expect(
      out
        .trimEnd()
        .endsWith(
          'message to qa, cr [action]: Please review… (not typed in yet for qa, cr; it is on its way, do not resend it)',
        ),
    ).toBe(true);
    expect(formatTaskDetail(detail)).not.toContain('not typed in yet');
  });

  it('shows a description as long as update_task accepts whole, and keeps timeline text short', () => {
    const detail = sampleTaskDetail();
    detail.task.description = `${'x'.repeat(19_999)}Z`;
    detail.timeline = [note(0, `multi\nline   ${'y'.repeat(1000)}`)];

    const out = formatTaskDetail(detail);

    expect(out).toContain(`Description:\n${'x'.repeat(19_999)}Z\n`);
    expect(out).not.toContain('only part of it');
    expect(out).toContain('note: multi line yyy');
    // The text is cut to 300 characters; the rest is the line's prefix and the cut hint (PM-191).
    expect(out.split('\n').find((l) => l.includes('note: multi'))!.length).toBeLessThan(480);
  });

  it('says on a cut note how long it is and how to read it whole, and leaves short ones alone (PM-191)', () => {
    const detail = sampleTaskDetail();
    detail.timeline = [note(0, 'x'.repeat(2000)), note(1, 'short')];

    const out = formatTaskDetail(detail);

    expect(out).toContain('(cut, 2000 chars; read it whole: get_task task_key AR-21, event_id evt_note_0)');
    expect(out).toContain('note: short');
    expect(out.split('read it whole:')).toHaveLength(2);
  });

  it('shows one event whole, line breaks kept, when get_task is asked for it by id (PM-191)', () => {
    const detail = sampleTaskDetail();
    const text = `Measured:\n${'row 1234\n'.repeat(200)}end`;
    const out = formatTaskDetail({ ...detail, event: note(5, text) });

    expect(out).toContain(`evt_note_5`);
    expect(out).toContain(`characters, shown whole:\n${text}`);
    expect(out).not.toContain('Timeline (oldest first)');
  });

  it('shows a longer description in parts and says what is missing and how to read it', () => {
    const detail = sampleTaskDetail();
    detail.task.description = `${'a'.repeat(20_000)}${'b'.repeat(5_000)}`;

    const first = formatTaskDetail(detail);
    expect(first).toContain(
      `Description (characters 1–20000 of 25000; only part of it):\n${'a'.repeat(20_000)}\n`,
    );
    expect(first).not.toContain('bbb');
    expect(first).toContain(
      '(The description is cut: 5000 more characters are not shown. Read them with get_task, task_key AR-21, ' +
        'description_offset 20000. Do not replace the description with update_task before you have read all ' +
        'of it: the replacement must hold the whole text. It is longer than update_task accepts (20000 ' +
        'characters), so it cannot be replaced without losing text: add a note instead, or ask a human to ' +
        'edit it in the app.)',
    );

    const rest = formatTaskDetail(detail, { descriptionOffset: 20_000 });
    expect(rest).toContain(
      `Description (characters 20001–25000 of 25000; only part of it):\n${'b'.repeat(5_000)}\n`,
    );
    expect(rest).toContain('(The first 20000 characters are not shown (description_offset 0 reads them).');
    expect(rest).not.toContain('more characters are not shown');

    expect(formatTaskDetail(detail, { descriptionOffset: 30_000 })).toContain(
      'Description: nothing from offset 30000; it has 25000 characters (description_offset 0 reads it from the start).',
    );
  });

  it('counts characters, not UTF-16 units, and reads a short description from an offset', () => {
    const detail = sampleTaskDetail();
    detail.task.description = '  ÁrvíztűrŐ 🙂 tükörfúrógép  ';

    const out = formatTaskDetail(detail, { descriptionOffset: 10 });

    expect(out).toContain('Description (characters 11–24 of 24; only part of it):\n🙂 tükörfúrógép\n');
    expect(out).toContain(
      '(The first 10 characters are not shown (description_offset 0 reads them). Do not replace',
    );
    expect(out).not.toContain('longer than update_task accepts');
  });

  it('renders unknown event types generically', () => {
    const detail = sampleTaskDetail();
    detail.timeline = [
      { ...note(0, ''), type: 'permission_resolved', data: { inboxItemId: 'inbox_7', decision: 'allow' } },
    ];

    expect(formatTaskDetail(detail)).toContain(
      'qa: permission_resolved (inboxItemId=inbox_7, decision=allow)',
    );
  });
});

describe('formatTaskUpdate relations', () => {
  it('reports the relations a call added and removed, and that a duplicate closed the card', () => {
    const task = sampleTaskDetail().task;
    const relations = {
      add: [
        { kind: 'prerequisite', key: 'AR-19' },
        { kind: 'duplicate_of', key: 'AR-3' },
      ],
      remove: [{ kind: 'related', key: 'AR-4' }],
    };
    expect(formatTaskUpdate(task, { note: false, relations })).toBe(
      'Updated AR-21: relations added: needs first (prerequisite) AR-19, is a duplicate of AR-3; ' +
        'relations removed: is related to AR-4.\n' +
        'Now: Stage: dev · Status: active · Assignee: fe-1 · Labels: frontend',
    );
    expect(formatTaskUpdate({ ...task, status: 'cancelled' }, { note: false, relations })).toContain(
      '; the card is closed (cancelled) as a duplicate.',
    );
  });
});

describe('themes in the tool results (PM-192)', () => {
  it('shows a card its theme: key, title and state', () => {
    const detail = sampleTaskDetail();
    const theme = { key: 'AR-30', title: 'The epic', stageId: 'backlog', status: 'active' as const };
    expect(formatTaskDetail({ ...detail, theme })).toContain('\nTheme: AR-30 "The epic" · Status: open\n');
    // A closed theme says so, whatever status the card behind it has.
    expect(formatTaskDetail({ ...detail, theme: { ...theme, status: 'cancelled' } })).toContain(
      'Theme: AR-30 "The epic" · Status: closed',
    );
    expect(formatTaskDetail(detail)).not.toContain('Theme:');
  });

  it('shows a theme its cards, collecting cards with their subtasks, and its progress', () => {
    const detail = sampleTaskDetail();
    detail.task = { ...detail.task, key: 'AR-30', title: 'The epic', kind: 'theme', stageId: 'backlog' };
    const out = formatTaskDetail({
      ...detail,
      themeProgress: { done: 1, total: 3 },
      themeCards: [
        {
          key: 'AR-1',
          title: 'Collecting',
          stageId: 'dev',
          status: 'active',
          subtasks: [{ key: 'AR-2', title: 'Part', stageId: 'done', status: 'done' }],
        },
        { key: 'AR-5', title: 'Alone', stageId: 'qa', status: 'active', subtasks: [] },
      ],
    });
    expect(out).toContain('AR-30 — The epic (a theme)\nKind: theme · Status: open · Labels: frontend\n');
    expect(out).not.toContain('Stage: backlog');
    expect(out).not.toContain('Assignee:');
    expect(out).toContain(
      [
        'Progress: 1 of 3 cards done (cancelled cards are not counted)',
        'Cards of this theme (collecting cards with their subtasks):',
        '- AR-1 "Collecting" · Stage: dev · Status: active',
        '  - AR-2 "Part" · Stage: done · Status: done',
        '- AR-5 "Alone" · Stage: qa · Status: active',
      ].join('\n'),
    );
    expect(formatTaskDetail({ ...detail, themeProgress: { done: 0, total: 0 }, themeCards: [] })).toContain(
      'Progress: 0 of 0 cards done (cancelled cards are not counted)\nCards of this theme: none.',
    );
  });

  it('words the theme events of a card and of a theme', () => {
    const detail = sampleTaskDetail();
    const event = (data: Record<string, unknown>, minute: number) => ({
      ...note(minute, ''),
      type: 'task_theme_changed' as const,
      data,
    });
    detail.timeline = [
      event({ themeKey: 'AR-30', previous: null }, 1),
      event({ themeKey: 'AR-31', previous: 'AR-30' }, 2),
      event({ themeKey: null, previous: 'AR-31' }, 3),
      { ...note(4, ''), type: 'task_updated', data: { action: 'closed', fields: ['status', 'closedAt'] } },
    ];
    const out = formatTaskDetail(detail);
    expect(out).toContain('put it into the theme AR-30');
    expect(out).toContain('moved it from the theme AR-30 to AR-31');
    expect(out).toContain('took it out of the theme AR-31');
    expect(out).toContain('closed the theme');
  });

  it('says what update_task did with the theme, and that a theme was created', () => {
    const task = sampleTaskDetail().task;
    expect(formatTaskUpdate(task, { note: false, themeKey: 'AR-30' })).toContain('theme set to AR-30');
    expect(formatTaskUpdate(task, { note: false, themeKey: null })).toContain('theme removed');
    expect(formatTaskUpdate(task, { note: false })).not.toContain('theme');
    const created = formatTaskCreated({ ...task, key: 'AR-30', kind: 'theme', labels: [] });
    expect(created).toContain('Created the theme AR-30');
    expect(created).toContain('in no stage');
    expect(created).not.toContain('unassigned');
    expect(formatTaskCreated(task)).toContain('unassigned');
  });
});

describe('formatSentMessage', () => {
  it('explains info delivery and names the pending permission decider', () => {
    const out = formatSentMessage({
      messageId: 'msg_1',
      requested: ['qa', 'cr'],
      deliveredTo: ['qa', 'cr'],
      taskKey: 'AR-1',
      recipients: [
        { handle: 'qa', delivery: 'next_input' },
        {
          handle: 'cr',
          delivery: 'after_turn',
          waitingPermission: { inboxItemId: 'inb_1', deciders: ['owner'], since: '2026-10-05T21:30:00.000Z' },
        },
      ],
    });
    expect(out).toContain('qa: they get it with their next input; it starts nothing');
    expect(out).toContain('waiting for a permission decision since');
    expect(out).toContain('decides: owner');
    expect(out).toContain('in one input with the others');
  });
  it('says why a recipient without a role on the card is not started (PM-426)', () => {
    const out = formatSentMessage({
      messageId: 'msg_1',
      requested: ['dev'],
      deliveredTo: ['dev'],
      taskKey: 'AR-1',
      recipients: [{ handle: 'dev', delivery: 'next_input', noWake: 'no_card_role' }],
    });
    expect(out).toContain(
      '- dev: not started: they have no role on AR-1 (not its assignee or a reviewer, and they have not worked on it), and a message from an AI member starts only members with a role there. They get it the next time they work on AR-1. If they really must act now, ask a person to bring them in.',
    );
    expect(out).not.toContain('it starts nothing');
  });
  it('says the Operator starts only on the owner’s request (PM-447)', () => {
    const out = formatSentMessage({
      messageId: 'msg_1',
      requested: ['operator'],
      deliveredTo: ['operator'],
      taskKey: null,
      recipients: [{ handle: 'operator', delivery: 'next_input', noWake: 'operator_owner_only' }],
    });
    expect(out).toContain(
      '- operator: not started: the Operator works only when the owner asks, and a message from anyone else starts nothing. They get it the next time the owner talks to them. If it really must reach the owner, ask a person to relay it.',
    );
    expect(out).not.toContain('it starts nothing');
  });
  it('reports recipients the message did not reach', () => {
    expect(
      formatSentMessage({
        messageId: 'msg_1',
        requested: ['qa', 'cr'],
        deliveredTo: ['qa'],
        recipients: [{ handle: 'qa', delivery: 'typed_now' }],
        taskKey: null,
      }),
    ).toBe('Message msg_1 sent to qa. Not delivered to: cr.\n- qa: typed into their session now.');
  });

  it('says per recipient what happens to the message (PM-144)', () => {
    const text = formatSentMessage({
      messageId: 'msg_1',
      requested: ['p', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      deliveredTo: ['p', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      recipients: [
        { handle: 'p', delivery: 'inbox' },
        { handle: 'a', delivery: 'typed_now' },
        { handle: 'b', delivery: 'after_turn' },
        { handle: 'c', delivery: 'wake' },
        { handle: 'd', delivery: 'held', hold: 'refinement_turn' },
        { handle: 'e', delivery: 'held', hold: 'fix_limit' },
        { handle: 'f', delivery: 'held', hold: 'full_test' },
        { handle: 'g', delivery: 'held', hold: 'pause' },
        { handle: 'h', delivery: 'held', hold: 'restart' },
      ],
      taskKey: 'PM-9',
    });
    expect(text.split('\n')).toEqual([
      'Message msg_1 about PM-9 sent to p, a, b, c, d, e, f, g, h.',
      '- p: a person; they read it in the app.',
      '- a: typed into their session now.',
      '- b: their session is busy; it gets the full text when its current turn ends. Do not resend it.',
      '- c: no session of theirs is running; one starts or resumes with the full text (it may wait for a free slot, a usage limit or a pause). Do not resend it.',
      '- d: held: PM-9 is being refined and it is not their turn; they get it on their turn or when the refinement ends.',
      '- e: held: PM-9 reached its fix round limit; they get it once that is decided.',
      "- f: held until the server's full test of PM-9's pinned commit has a result.",
      '- g: held: their session is paused; they get it when the pause ends.',
      '- h: held: their session restarts first (a new review round or permission mode); they get it in its first input.',
    ]);
  });

  it('says where a message went when it did not go to its own card (PM-182)', () => {
    expect(
      formatSentMessage({
        messageId: 'msg_x',
        requested: ['dev', 'claude'],
        deliveredTo: ['dev', 'claude'],
        recipients: [
          { handle: 'dev', delivery: 'typed_now' },
          { handle: 'claude', delivery: 'wake' },
        ],
        taskKey: 'PM-164',
        routed: [
          { handle: 'claude', workItem: { type: 'general' } },
          { handle: 'dev', workItem: { type: 'task', taskKey: 'PM-162' } },
        ],
      }),
    ).toContain(
      'claude gets it in their general chat, because PM-164 is closed. ' +
        'dev gets it in their running session on PM-162, a card of the same family as PM-164.',
    );
  });
});

describe('questionHint', () => {
  const MOVE_DETAIL = 'Consider moving detail into details.';
  const RECOMMEND =
    'Consider adding a recommendation with a one-sentence reason (recommended, recommendation_reason).';

  it('has no hint for a short question with a recommendation', () => {
    expect(questionHint({ question: 'x'.repeat(300), recommended: 'Yes' })).toBeNull();
  });

  it('suggests moving detail into details above 300 characters', () => {
    expect(questionHint({ question: 'x'.repeat(301), recommended: 'Yes' })).toBe(MOVE_DETAIL);
  });

  it('suggests a recommendation when there is none', () => {
    expect(questionHint({ question: 'Ship it?' })).toBe(RECOMMEND);
    expect(questionHint({ question: 'Ship it?', recommended: undefined })).toBe(RECOMMEND);
  });

  it('gives both as one line', () => {
    expect(questionHint({ question: 'x'.repeat(301) })).toBe(`${MOVE_DETAIL} ${RECOMMEND}`);
  });
});

describe('formatQuestionAsked', () => {
  it('says where the question is, for whom, and adds the hint on its own line, meant for the next one', () => {
    expect(formatQuestionAsked('inb_1', undefined, { question: 'Ship it?', recommended: 'Yes' })).toBe(
      'Question inb_1 is waiting in the inbox.',
    );
    expect(formatQuestionAsked('inb_1', ['owner', 'anna'], { question: 'Ship it?' })).toBe(
      'Question inb_1 is waiting in the inbox of owner, anna.\n' +
        'Tip for your next question: Consider adding a recommendation with a one-sentence reason ' +
        '(recommended, recommendation_reason).',
    );
  });
});

describe('related task formatting', () => {
  it('includes parent and subtasks with key, title, stage and status', () => {
    const detail = sampleTaskDetail();
    detail.parent = {
      ...detail.task,
      key: 'AR-20',
      title: 'Example parent',
      stageId: 'ready',
      status: 'waiting',
    };
    detail.subtasks = [
      { ...detail.task, key: 'AR-22', title: 'Example child', stageId: 'qa', status: 'done' },
    ];
    const out = formatTaskDetail(detail);
    expect(out).toContain('Parent: AR-20 — Example parent · Stage: ready · Status: waiting');
    expect(out).toContain('- AR-22 — Example child · Stage: qa · Status: done');
  });
});
