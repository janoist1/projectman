import type { TaskLink, TimelineEvent, TimelineEventType } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import {
  describeAttachment,
  describeEvent,
  describeLink,
  eventFullText,
  formatBytes,
  describeRepo,
  formatTimestamp,
  linkTarget,
  oneLine,
  recentTimeline,
  truncate,
  type TextStyle,
} from '.';

/** The context pack's kind of style: inline code and names. */
const named: TextStyle = {
  code: (value) => `\`${value}\``,
  stage: (id) => ({ dev: 'Development', qa: 'QA' })[id] ?? id,
  label: (id) => (id === 'qa-ok' ? '`qa-ok` (QA ok)' : `\`${id}\``),
};

let seq = 0;
function event(
  type: TimelineEventType,
  data: Record<string, unknown>,
  createdAt = '2026-09-29T10:00:00.000Z',
  handle: string | null = 'qa',
): TimelineEvent {
  seq += 1;
  return {
    id: `evt_${seq}`,
    projectKey: 'AR',
    taskKey: 'AR-21',
    sessionId: null,
    actor: { kind: handle ? 'ai' : 'system', handle },
    type,
    data,
    createdAt,
  };
}

describe('free text', () => {
  it('leaves short text alone and marks cut text', () => {
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('abcd', 3)).toBe('ab…');
    expect(truncate('ab cd', 4)).toBe('ab…');
  });

  it('never splits a character made of two code units', () => {
    expect(truncate('😀😀😀', 2)).toBe('😀…');
  });

  it('collapses whitespace to one line', () => {
    expect(oneLine('  multi\n\nline\ttext ', 100)).toBe('multi line text');
    expect(oneLine('a\nb c d', 4)).toBe('a b…');
  });

  it('writes timestamps in UTC', () => {
    expect(formatTimestamp('2026-09-29T14:05:59.000Z')).toBe('2026-09-29 14:05 UTC');
    expect(formatTimestamp('2026-09-29T16:05:00+02:00')).toBe('2026-09-29 14:05 UTC');
    expect(formatTimestamp('yesterday')).toBe('yesterday');
  });
});

describe('links', () => {
  const links: TaskLink[] = [
    { kind: 'pull_request', ref: '123', repo: 'acme/app', title: 'Fix the\nmail', state: 'open' },
    { kind: 'issue', ref: '7', repo: 'acme/app' },
    { kind: 'branch', ref: 'AR-21-fix', repo: 'acme/app' },
    { kind: 'url', ref: 'https://example.com/r/42', title: 'Client report' },
    { kind: 'prerequisite', ref: 'AR-19', title: 'Update mail templates', state: 'done' },
  ];

  it('names the kind of each link', () => {
    expect(links.map((l) => describeLink(l))).toEqual([
      'Pull request: acme/app#123 "Fix the mail" (open)',
      'Issue: acme/app#7',
      'Branch: AR-21-fix in acme/app',
      'Link: https://example.com/r/42 "Client report"',
      'Prerequisite: AR-19 "Update mail templates" (done)',
    ]);
  });

  it('quotes branches in the given style and can leave the kind out', () => {
    expect(describeLink(links[2]!, named)).toBe('Branch: `AR-21-fix` in acme/app');
    expect(linkTarget(links[4]!, named)).toBe('AR-19 "Update mail templates" (done)');
  });
});

describe('describeEvent', () => {
  it('names the labels of a label change', () => {
    const changed = event('task_labels_changed', { added: ['qa-ok'], removed: ['qa-failed', 'qa-retest'] });
    expect(describeEvent(changed, 100)).toBe('labels added: qa-ok; labels removed: qa-failed, qa-retest');
    expect(describeEvent(changed, 100, named)).toBe(
      'labels added: `qa-ok` (QA ok); labels removed: `qa-failed`, `qa-retest`',
    );
    expect(describeEvent(event('task_labels_changed', { added: [], removed: [] }), 100)).toBe(
      'changed the labels',
    );
  });

  it("words the server's full test and the send-back it causes (PM-217)", () => {
    const commit = 'a'.repeat(40);
    const run = { runId: 'ftr_1', repo: 'web', branch: 'task/AR-1', commit, durationMs: 5, exitCode: 0 };
    expect(describeEvent(event('task_full_test', { ...run, outcome: 'passed' }), 100)).toBe(
      `the full test passed on commit ${'a'.repeat(12)}`,
    );
    expect(
      describeEvent(event('task_full_test', { ...run, outcome: 'failed', failedFiles: ['a.test.ts'] }), 100),
    ).toBe(`the full test failed on commit ${'a'.repeat(12)}: a.test.ts`);
    expect(describeEvent(event('task_full_test', { ...run, outcome: 'failed', failedFiles: [] }), 100)).toBe(
      `the full test failed on commit ${'a'.repeat(12)}`,
    );
    expect(describeEvent(event('task_full_test', { ...run, outcome: 'error', reason: 'timeout' }), 100)).toBe(
      `the full test could not run on commit ${'a'.repeat(12)} (timeout)`,
    );
    expect(
      describeEvent(
        event('task_stage_changed', {
          from: 'qa',
          to: 'dev',
          testsFailed: { runId: 'ftr_1', branch: 'b', commit },
        }),
        100,
      ),
    ).toBe('moved it from qa to dev (the full test failed)');
    // The output is read whole with get_task, not in the line.
    expect(
      eventFullText(event('task_full_test', { ...run, outcome: 'failed', outputTail: ' FAIL a ' })),
    ).toBe('FAIL a');
  });

  it('still words legacy check events', () => {
    expect(
      describeEvent(event('task_check_changed', { check: 'qa', from: 'pending', to: 'passed' }), 100),
    ).toBe('set the qa check to passed (was pending)');
    expect(describeEvent(event('task_check_changed', { check: 'qa', from: null, to: 'pending' }), 100)).toBe(
      'set the qa check to pending',
    );
  });

  it('words task changes with stage names and quoted handles in the given style', () => {
    const moved = event('task_stage_changed', { from: 'dev', to: 'qa' });
    expect(describeEvent(moved, 100)).toBe('moved it from dev to qa');
    expect(describeEvent(moved, 100, named)).toBe('moved it from Development to QA');
    expect(describeEvent(event('task_assigned', { assignee: 'fe-1' }), 100, named)).toBe(
      'assigned it to `fe-1`',
    );
    expect(describeEvent(event('task_assigned', { assignee: null }), 100)).toBe('unassigned it');
    expect(describeEvent(event('task_updated', { fields: ['title', 'description'] }), 100)).toBe(
      'updated title, description',
    );
    expect(
      describeEvent(event('task_link_added', { kind: 'pull_request', ref: '123', repo: 'acme/app' }), 100),
    ).toBe('linked pull request acme/app#123');
    expect(describeEvent(event('task_created', {}), 100)).toBe('created the task');
  });

  it('words attachment events with the file name kept in the audit', () => {
    const data = { attachmentId: 'att_1234567890', fileName: 'plan.png', size: 5, mediaType: 'image/png' };
    expect(describeEvent(event('attachment_added', data), 100)).toBe('attached the file plan.png');
    expect(describeEvent(event('attachment_deleted', data), 100)).toBe('deleted the attachment plan.png');
  });

  it('says why a task was updated when the event tells', () => {
    const updated = (data: Record<string, unknown>) =>
      describeEvent(event('task_updated', { fields: ['status'], ...data }), 100, named);
    expect(updated({ action: 'cancelled', previousStatus: 'active', reason: 'Duplicate of AR-7' })).toBe(
      'cancelled the task: Duplicate of AR-7',
    );
    expect(updated({ action: 'cancelled' })).toBe('cancelled the task');
    expect(updated({ action: 'reopened', previousAssignee: 'fe-1' })).toBe('reopened the task');
    expect(updated({ gateRequest: { requestId: 'r1', from: 'dev', to: 'qa', inboxItemIds: ['i1'] } })).toBe(
      'asked a human to approve the move to QA',
    );
    expect(updated({ gateRejected: { requestId: 'r1', to: 'qa', inboxItemId: 'i1' } })).toBe(
      'the move to QA was not approved',
    );
    expect(updated({ gateBlocked: { to: 'qa', reason: 'unknown_stage' } })).toBe(
      'the approved move to QA could not happen (unknown_stage)',
    );
    expect(
      describeEvent(
        event('task_updated', {
          fields: ['links'],
          pullRequest: { repo: 'acme/app', number: 12, state: 'merged' },
        }),
        100,
      ),
    ).toBe('pull request acme/app#12 is merged');
  });

  it('names the repositories of a repository change, and only the field when it does not say', () => {
    const updated = (data: Record<string, unknown>, style?: TextStyle) =>
      describeEvent(event('task_updated', data), 100, style);
    expect(updated({ fields: ['repo'], repo: 'api', previousRepo: null })).toBe('updated repo (none -> api)');
    expect(updated({ fields: ['repo'], repo: null, previousRepo: 'api' }, named)).toBe(
      'updated repo (`api` -> none)',
    );
    expect(updated({ fields: ['title', 'repo'], repo: 'web', previousRepo: 'api' }, named)).toBe(
      'updated title, repo (`api` -> `web`)',
    );
    // Recorded without the repositories: the field is all there is to say.
    expect(updated({ fields: ['repo'] })).toBe('updated repo');
    expect(updated({ fields: ['title'] })).toBe('updated title');
  });

  it('describes where the work of a task happens', () => {
    expect(describeRepo({ name: 'web', choiceNeeded: false })).toBe('web');
    expect(describeRepo({ name: 'web', choiceNeeded: false }, named)).toBe('`web`');
    expect(describeRepo({ name: null, choiceNeeded: false })).toBe('the workspace root');
    expect(describeRepo({ name: null, choiceNeeded: true }, named)).toBe(
      'none chosen yet (the project has several repositories; ask a human which one if you need to know)',
    );
  });

  it('shortens free text to the limit', () => {
    const note = event('task_note', { text: `multi\nline ${'y'.repeat(500)}` });
    const text = describeEvent(note, 50);
    expect(text.startsWith('note: multi line yyy')).toBe(true);
    expect(text).toHaveLength('note: '.length + 50);
    expect(
      describeEvent(event('team_message', { to: ['fe-1', 'owner'], excerpt: 'Ready' }), 100, named),
    ).toBe('message to `fe-1`, `owner`: Ready');
  });

  it('shows the data of event types without their own wording', () => {
    expect(
      describeEvent(
        event('permission_resolved', { inboxItemId: 'inbox_7', decision: 'allow', extra: {} }),
        100,
      ),
    ).toBe('permission_resolved (inboxItemId=inbox_7, decision=allow)');
    expect(describeEvent(event('session_ended', {}), 100)).toBe('session_ended');
  });
});

describe('recentTimeline', () => {
  it('shows the most recent events oldest first, after skipping', () => {
    const events = [
      event('task_note', { text: 'third' }, '2026-09-29T10:03:00.000Z'),
      event('session_started', { member: 'qa' }, '2026-09-29T10:04:00.000Z', null),
      event('task_note', { text: 'first' }, '2026-09-29T10:01:00.000Z'),
      event('task_note', { text: 'second' }, '2026-09-29T10:02:00.000Z'),
    ];
    const { lines, total } = recentTimeline(events, {
      limit: 2,
      textLimit: 100,
      style: named,
      skip: new Set(['session_started']),
    });
    expect(total).toBe(3);
    expect(lines).toEqual([
      '- 2026-09-29 10:02 UTC · `qa`: note: second',
      '- 2026-09-29 10:03 UTC · `qa`: note: third',
    ]);
    expect(recentTimeline(events, { limit: 10, textLimit: 100 }).lines[3]).toBe(
      '- 2026-09-29 10:04 UTC · system: session_started (member=qa)',
    );
  });
});

describe('attachments', () => {
  it('formats sizes in decimal units, like the 25 MB limit', () => {
    expect([0, 999, 1000, 48_213, 1_250_000, 25_000_000, 3_400_000_000].map(formatBytes)).toEqual([
      '0 B',
      '999 B',
      '1 kB',
      '48.2 kB',
      '1.3 MB',
      '25 MB',
      '3.4 GB',
    ]);
  });

  it('names the uploader, or the system for an attachment without one', () => {
    const attachment = {
      id: 'att_abcdefghij',
      projectKey: 'AR',
      taskKey: 'AR-1',
      fileName: 'a  long\nname.png',
      size: 10,
      mediaType: 'image/png',
      preview: 'image' as const,
      uploadedBy: { kind: 'ai' as const, handle: 'fe-1' },
      createdAt: '2026-09-29T10:00:00.000Z',
    };
    expect(describeAttachment(attachment)).toBe(
      'att_abcdefghij "a long name.png" · image/png · 10 B · by fe-1, 2026-09-29 10:00 UTC',
    );
    expect(describeAttachment({ ...attachment, uploadedBy: { kind: 'system', handle: null } })).toContain(
      'by the system,',
    );
  });
});
