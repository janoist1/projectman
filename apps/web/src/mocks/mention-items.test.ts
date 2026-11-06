import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mentionPayloadOf } from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import { MockBackend } from './backend';

describe('mock mention items (PM-1307)', () => {
  let backend: MockBackend;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T10:00:00.000Z'));
    backend = new MockBackend();
    backend.tasks = [backend.tasks[0]!];
    backend.inbox = [];
    backend.messages = [];
  });
  afterEach(() => vi.useRealTimers());

  const key = () => backend.tasks[0]!.key;
  const comment = (viewer: string, text: string, replyTo?: string) => {
    backend.viewerHandle = viewer;
    vi.advanceTimersByTime(1000);
    expect(backend.addTaskComment(key(), { text, ...(replyTo ? { replyTo } : {}) })).toBeNull();
    return backend.timeline.filter((event) => event.type === 'task_note').at(-1)!.id;
  };
  const mentions = (): InboxItem[] => backend.inbox.filter((item) => item.kind === 'mention');

  it('opens one item per mentioned human, not for an AI member or the author', () => {
    const top = comment('owner', '@kata @fe-1 @owner please look');
    expect(mentions()).toHaveLength(1);
    expect(mentions()[0]).toMatchObject({
      assignees: ['kata'],
      source: 'owner',
      taskKey: key(),
      state: 'open',
    });
    expect(mentionPayloadOf(mentions()[0]!)).toEqual({ eventId: top, place: 'comment', threadId: top });
  });

  it('closes only the replier’s own items of the thread the reply goes to', () => {
    const first = comment('owner', '@kata first');
    const second = comment('owner', '@kata second');
    comment('kata', 'standalone');
    comment('kata', 'answer', second);
    const [one, two] = mentions();
    expect(one!.state).toBe('open');
    expect(two).toMatchObject({
      state: 'resolved',
      resolution: { optionId: 'replied', rule: 'mention_replied' },
    });
    comment('kata', 'answer', first);
    expect(mentions().map((item) => item.state)).toEqual(['resolved', 'resolved']);
  });

  it('opens nothing for an imported comment', () => {
    backend.viewerHandle = 'owner';
    backend.addTaskComment(key(), { text: '@kata old', importedAuthor: 'Morgan' });
    expect(mentions()).toEqual([]);
  });
});
