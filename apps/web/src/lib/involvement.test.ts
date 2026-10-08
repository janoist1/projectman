import { describe, expect, it } from 'vitest';
import { SessionStartCauseKind, SessionStopKind } from '@projectman/shared';
import type { TimelineEvent } from '@projectman/shared';
import { t } from '../i18n/t';
import { describeStart, describeStop, involvementText } from './involvement';
import { AUTOMATIC_CLOSURES, closureReason, isAutomaticClosureKind } from './sessions';

const event: TimelineEvent = {
  id: 'evt_1',
  projectKey: 'AC',
  taskKey: 'AC-1',
  sessionId: 'ses_1',
  actor: { kind: 'ai', handle: 'dev' },
  type: 'session_started',
  data: { member: 'dev', resumed: false },
  createdAt: '2026-10-08T10:00:00.000Z',
};
const ctx = { members: new Map(), pipeline: null, myHandle: 'owner', openInboxIds: new Set<string>() };
describe('involvement descriptions', () => {
  it.each(SessionStartCauseKind.options)('describes start cause %s', (kind) => {
    const view = describeStart(
      {
        ...event,
        data: { ...event.data, cause: { kind, by: { kind: 'human', handle: 'owner' }, quote: 'Hello.' } },
      },
      ctx,
    );
    expect(view.reason).toBe(t(`involvement.reasons.${kind}`));
    expect(view.by).toBe(t('common.you'));
    expect(view.ref?.text).toBe(t('involvement.quote', { text: 'Hello.' }));
  });
  it.each(SessionStopKind.options)('describes stop kind %s', (kind) => {
    const view = describeStop(
      { ...event, type: 'session_ended', data: { stop: { kind }, exitCode: kind === 'failed' ? 1 : 0 } },
      ctx,
    );
    expect(view.verb).toBe(
      t(AUTOMATIC_CLOSURES.has(kind) ? 'involvement.verbs.closed' : 'involvement.verbs.ended'),
    );
    expect(view.reason).toBe(
      isAutomaticClosureKind(kind)
        ? closureReason({ kind }, ctx).long
        : t(`involvement.stops.${kind}`, { code: '1' }),
    );
  });
  it('keeps old and unknown causes readable', () => {
    for (const cause of [undefined, { kind: 'future_kind' }]) {
      expect(describeStart({ ...event, data: { cause } }, ctx).verb).toBe(
        t('timeline.events.session_started'),
      );
    }
  });
  it('never calls the integrator you and does not invent a hidden quote', () => {
    const view = describeStart(
      {
        ...event,
        data: {
          cause: {
            kind: 'message',
            messageId: 'msg_1',
            by: { kind: 'human', handle: 'owner', via: 'integrator' },
          },
        },
      },
      ctx,
    );
    expect(view.by).toBe(t('involvement.integrator'));
    expect(view.ref?.text).toBe('');
    expect(involvementText(view)).not.toContain('„');
  });
  it('records a manual stop with and without a note', () => {
    for (const note of [undefined, 'Wrong card']) {
      const view = describeStop(
        { ...event, data: { stop: { kind: 'manual', by: { kind: 'human', handle: 'owner' }, note } } },
        ctx,
      );
      expect(view.verb).toBe(t('involvement.verbs.stopped'));
      expect(view.reason).toBe(note ? t('involvement.quote', { text: note }) : '');
      expect(involvementText({ ...view, verb: '' }).startsWith(' · ')).toBe(false);
    }
  });
  it('omits schedule run identifiers and empty stop details', () => {
    const view = describeStart(
      { ...event, data: { cause: { kind: 'schedule', by: { kind: 'system' }, runId: 'run_internal' } } },
      ctx,
    );
    expect(involvementText(view)).not.toContain('run_internal');
    expect(
      involvementText({ ...describeStop({ ...event, data: { stop: { kind: 'exited' } } }, ctx), verb: '' }),
    ).toBe('');
  });
});
