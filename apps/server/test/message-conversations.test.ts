import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

let h: DomainHarness;
beforeEach(async () => {
  h = await createDomainHarness();
});
afterEach(async () => h.cleanup());

it.each([
  { name: 'integrator request', via: 'integrator' as const },
  { name: 'mention', origin: { kind: 'note' as const, eventId: 'evt_note' } },
  { name: 'answer', answer: { inboxItemId: 'inb_question', question: 'Question', answer: 'Answer' } },
  { name: 'operator request', operatorRequest: 'opr_request' },
  { name: 'operator signal', operatorSignal: 'sig_signal' },
])('stores $name as machine history', ({ name: _name, via, ...extra }) => {
  const message = h.domain.messages.record({
    projectKey: 'AR',
    from: 'owner',
    to: ['pm'],
    taskKey: null,
    body: 'Message',
    actor: { ...OWNER_ACTOR, ...(via ? { via } : {}) },
    ...extra,
  });
  expect(h.repos.messages.get(message.id)).not.toHaveProperty('conversation');
  const event = h.domain.timeline.list('AR').find((e) => e.data?.messageId === message.id)!;
  if ('origin' in extra) expect(event.data).toMatchObject({ excerpt: '', noteEventId: 'evt_note' });
});

it('stores AI conversations without a direct placement', () => {
  const message = h.domain.messages.record({
    projectKey: 'AR',
    from: 'dev-1',
    to: ['cr'],
    taskKey: null,
    body: 'Machine message',
    actor: { kind: 'ai', handle: 'dev-1' },
  });
  expect(h.repos.messages.get(message.id)?.conversation).toBeUndefined();
});
