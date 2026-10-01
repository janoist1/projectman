import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '@projectman/shared';
import { t } from '../i18n/t';
import { describeEvent } from './timeline';

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

describe('creation timeline labels', () => {
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
