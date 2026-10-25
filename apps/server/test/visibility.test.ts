import { describe, expect, it } from 'vitest';
import type { InboxItem, Session, TaskDetail, TeamMessage, TimelineEvent } from '@projectman/shared';
import {
  canSeeProjectEvent,
  teamMessageParticipant,
  visibleProjectEvent,
  visibleSession,
  visibleTaskDetail,
} from '../src/core/projects';
import type { ProjectEvent } from '../src/core/projects';

const client = { access: 'client' as const, handle: 'acme-client' };
const developer = { access: 'developer' as const, handle: 'dev' };
const viewer = { access: 'viewer' as const, handle: 'reader' };
const owner = { access: 'owner' as const, handle: 'owner' };
const admin = { access: 'admin' as const, handle: 'boss' };

const timeline = (type: TimelineEvent['type'], data?: TimelineEvent['data']) =>
  ({ type, data }) as TimelineEvent;
const item = (assignees: string[]) => ({ assignees }) as InboxItem;
const message = (from: string, to: string[]) => ({ from, to }) as TeamMessage;
const quoted = (messageId: string) =>
  timeline('session_started', { cause: { messageId, quote: 'a private line' } });

describe('what a member sees of their project', () => {
  it('shows a client the whole card, as it shows a read-only member (PM-79)', () => {
    const detail = {
      task: { key: 'AR-1', visibility: 'internal', links: [{ kind: 'prerequisite', ref: 'AR-2' }] },
      parent: { key: 'AR-2', visibility: 'internal' },
      subtasks: [{ key: 'AR-3', visibility: 'internal' }],
      pullRequests: [],
      timeline: ['task_created', 'task_note', 'task_labels_changed', 'task_merge_requested'].map((type) =>
        timeline(type as TimelineEvent['type']),
      ),
      sessions: [{ id: 'ses_1' }],
    } as unknown as TaskDetail;
    expect(visibleTaskDetail(client, detail)).toBe(detail);
    expect(visibleTaskDetail(viewer, detail)).toBe(detail);
  });

  it('delivers a client the live events of every card, member and timeline entry', () => {
    const live = [
      { type: 'task_upserted', projectKey: 'AR', task: { key: 'AR-2', visibility: 'internal' } },
      { type: 'timeline_appended', projectKey: 'AR', event: timeline('task_created') },
      { type: 'member_state', projectKey: 'AR', handle: 'dev', status: 'working', activity: 'Read file' },
      { type: 'member_changed', projectKey: 'AR', handle: 'dev', member: null },
      { type: 'task_attachments_changed', projectKey: 'AR', taskKey: 'AR-2' },
      { type: 'chat_appended', projectKey: 'AR', sessionId: 'ses_1' },
      { type: 'config_changed', projectKey: 'AR', version: 'abc' },
    ] as ProjectEvent[];
    for (const event of live) {
      expect(
        canSeeProjectEvent(client, event, () => false),
        event.type,
      ).toBe(true);
      expect(visibleProjectEvent(client, event), event.type).toEqual(event);
    }
  });

  it('shows a client the inbox of the others too, but not the owner-only events', () => {
    for (const assignee of ['acme-client', 'owner'])
      expect(
        canSeeProjectEvent(client, { type: 'inbox_upserted', projectKey: 'AR', item: item([assignee]) }),
      ).toBe(true);
    const checklist = { type: 'project_checklist_changed', projectKey: 'AR' } as ProjectEvent;
    expect(canSeeProjectEvent(client, checklist)).toBe(false);
    expect(canSeeProjectEvent(owner, checklist)).toBe(true);
  });

  it('cuts the quote of a team message that started a session from those it is not for (PM-78)', () => {
    const lookup = (id: string) => (id === 'msg_1' ? { from: 'qa', to: ['designer'] } : null);
    const detail = (event: TimelineEvent) =>
      ({ task: { key: 'AR-1' }, timeline: [event], sessions: [] }) as unknown as TaskDetail;
    const cut = visibleTaskDetail(client, detail(quoted('msg_1')), lookup).timeline[0]!;
    expect(cut.data?.cause).toEqual({ messageId: 'msg_1' });
    // The party to the message, an owner and an admin read it.
    const party = { access: 'developer' as const, handle: 'designer' };
    for (const reader of [party, owner, admin])
      expect(visibleTaskDetail(reader, detail(quoted('msg_1')), lookup).timeline[0]).toEqual(quoted('msg_1'));
    const session = {
      id: 'ses_1',
      startCause: { messageId: 'msg_1', quote: 'a private line' },
    } as unknown as Session;
    expect(visibleSession(client, session, lookup).startCause).toEqual({ messageId: 'msg_1' });
    expect(visibleSession(owner, session, lookup)).toBe(session);
  });

  it('narrows team messages to those a member sent or got, except for an owner and an admin (PM-78)', () => {
    expect(teamMessageParticipant(owner)).toBeUndefined();
    expect(teamMessageParticipant(admin)).toBeUndefined();
    for (const member of [developer, viewer, client])
      expect(teamMessageParticipant(member)).toBe(member.handle);
    const fromTo = (from: string, to: string[]): ProjectEvent => ({
      type: 'team_message',
      projectKey: 'AR',
      message: message(from, to),
    });
    const others = fromTo('qa', ['designer']);
    const toDeveloper = fromTo('qa', ['designer', 'dev']);
    const fromDeveloper = fromTo('dev', ['qa']);
    for (const viewerOf of [owner, admin]) {
      expect(canSeeProjectEvent(viewerOf, others)).toBe(true);
    }
    for (const member of [developer, viewer, client]) {
      expect(canSeeProjectEvent(member, others)).toBe(false);
    }
    expect(canSeeProjectEvent(developer, toDeveloper)).toBe(true);
    expect(canSeeProjectEvent(developer, fromDeveloper)).toBe(true);
    expect(canSeeProjectEvent(client, fromTo('owner', ['acme-client']))).toBe(true);
    expect(canSeeProjectEvent(client, fromTo('acme-client', ['owner']))).toBe(true);
    expect(canSeeProjectEvent(client, fromTo('owner', ['dev']))).toBe(false);
  });
});
