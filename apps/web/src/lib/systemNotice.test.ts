import { SYSTEM_NOTICE_KINDS } from '@projectman/shared';
import type { SystemNoticeKind, TeamMessage } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { messageText } from './systemNotice';

function message(origin: TeamMessage['origin'], body = 'Stored English text'): TeamMessage {
  return {
    id: 'msg_1',
    projectKey: 'AR',
    from: 'system',
    to: ['owner'],
    body,
    kind: 'info',
    taskKey: null,
    origin,
  } as unknown as TeamMessage;
}

const notice = (kind: SystemNoticeKind, params: Record<string, string | number> = {}) =>
  message({ kind: 'system_notice', notice: kind, params });

describe('messageText', () => {
  it('shows an ordinary message as it was written', () => {
    expect(messageText(message(undefined))).toBe('Stored English text');
  });

  it.each(SYSTEM_NOTICE_KINDS)('draws the %s notice from the locale, not from the stored text', (kind) => {
    const text = messageText(notice(kind, { reason: 'unknown_sender' }));
    expect(text).not.toBe('Stored English text');
    expect(text).not.toBe('');
    expect(text).not.toMatch(/messages\.notice/);
  });

  it('puts the values of the notice into its text', () => {
    expect(messageText(notice('session_tokens', { counted: 123, limit: 100 }))).toContain('123');
    expect(messageText(notice('refinement_done', { taskKey: 'AR-7' }))).toContain('AR-7');
  });

  it('tells an answered and a declined host request apart', () => {
    const params = { title: 'Need a right', answer: 'No.' };
    expect(messageText(notice('host_request_answered', { ...params, outcome: 'answered' }))).not.toBe(
      messageText(notice('host_request_answered', { ...params, outcome: 'declined' })),
    );
  });
});
