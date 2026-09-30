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
