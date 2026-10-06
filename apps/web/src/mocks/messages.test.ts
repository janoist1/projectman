import { describe, expect, it } from 'vitest';
import { MemberProfile, Session, TeamMessage, TeamMessagesView, TeamThreadsView } from '@projectman/shared';
import type { ServerEvent } from '@projectman/shared';
import { MockBackend } from './backend';

const base = '/api/projects/AC';
function backend() {
  const b = new MockBackend();
  b.sessions = [];
  b.tasks = [];
  b.messages = [];
  b.planUsage.fiveHourPercent = 0;
  b.planUsage.weeklyPercent = 0;
  return b;
}
describe('mock team messaging and profiles', () => {
  it('queues AI messages, delivers them to a reused general session and preserves human receipts', () => {
    const b = backend();
    const message = TeamMessage.parse(
      b.handle('POST', `${base}/messages`, { to: ['fe-1', 'kata'], text: 'Acme conversation' }).body,
    );
    expect(message.receipts).toMatchObject([
      { kind: 'ai', deliveredAt: null },
      { kind: 'human', deliveredAt: expect.any(String), readAt: null },
    ]);
    expect(b.sessions).toHaveLength(0);
    const session = Session.parse(b.handle('POST', `${base}/members/fe-1/conversation`, {}).body);
    expect(session.workItem).toEqual({ type: 'general' });
    expect(b.messages[0]?.receipts?.[0]?.deliveredAt).toBeTruthy();
    expect(b.chats[session.id]).toContainEqual(
      expect.objectContaining({ kind: 'team_message', text: 'Acme conversation', from: 'owner' }),
    );
    expect(Session.parse(b.handle('POST', `${base}/members/fe-1/conversation`, {}).body).id).toBe(session.id);
    expect(b.chats[session.id]).toHaveLength(1);
    const next = TeamMessage.parse(
      b.handle('POST', `${base}/messages`, { to: ['fe-1'], text: 'Acme followup' }).body,
    );
    expect(next.deliveredAt).toBeTruthy();
  });
  it('keeps a busy session message queued until it is idle', () => {
    const b = backend();
    const session = Session.parse(b.handle('POST', `${base}/members/fe-1/conversation`, {}).body);
    b.updateSession(session.id, { state: 'working' });
    const message = TeamMessage.parse(
      b.handle('POST', `${base}/messages`, { to: ['fe-1'], text: 'Acme followup' }).body,
    );
    expect(message.deliveredAt).toBeNull();
    expect(b.chats[session.id]).toHaveLength(0);
    b.updateSession(session.id, { state: 'idle' });
    expect(b.messages[0]?.deliveredAt).toBeTruthy();
    expect(b.chats[session.id]).toHaveLength(1);
  });
  it('keeps each human unread state separate and pushes read updates', () => {
    const b = backend();
    const message = TeamMessage.parse(
      b.handle('POST', `${base}/messages`, { to: ['kata', 'bence'], text: 'Acme review' }).body,
    );
    b.viewerHandle = 'kata';
    expect(TeamMessagesView.parse(b.handle('GET', `${base}/messages`, {}).body).unreadCount).toBe(1);
    expect(b.handle('POST', `${base}/messages/${message.id}/read`, {}).status).toBe(200);
    expect(TeamMessagesView.parse(b.handle('GET', `${base}/messages`, {}).body).unreadCount).toBe(0);
    b.viewerHandle = 'bence';
    expect(TeamMessagesView.parse(b.handle('GET', `${base}/messages`, {}).body).unreadCount).toBe(1);
    b.viewerHandle = 'owner';
    expect(b.handle('POST', `${base}/messages/${message.id}/read`, {}).status).toBe(403);
  });
  it('gives only an owner and an admin the messages of others, with every filter (PM-78)', () => {
    const b = backend();
    for (const [from, to, taskKey] of [
      ['fe-1', ['qa'], 'AC-1'],
      ['qa', ['fe-1', 'kata'], null],
      ['kata', ['owner'], null],
    ] as const)
      b.sendTeamMessage(from, [...to], taskKey, `${from} writes`);
    const bodies = (query = '') =>
      TeamMessagesView.parse(
        b.handle('GET', `${base}/messages`, {}, new URLSearchParams(query)).body,
      ).messages.map((m) => m.body);
    expect(bodies()).toEqual(['fe-1 writes', 'qa writes', 'kata writes']);
    expect(bodies('?member=qa')).toEqual(['fe-1 writes', 'qa writes']);
    expect(bodies('?taskKey=AC-1')).toEqual(['fe-1 writes']);
    expect(bodies('?limit=1')).toEqual(['kata writes']);
    b.viewerHandle = 'kata';
    expect(bodies()).toEqual(['qa writes', 'kata writes']);
    expect(bodies('?member=fe-1')).toEqual(['qa writes']);
    expect(bodies('?taskKey=AC-1')).toEqual([]);
    expect(bodies('?threadWith=owner')).toEqual(['kata writes']);
    b.findMember('kata')!.role = 'viewer';
    expect(bodies()).toEqual(['qa writes', 'kata writes']);
    b.findMember('kata')!.role = 'admin';
    expect(bodies()).toEqual(['fe-1 writes', 'qa writes', 'kata writes']);
  });
  it('answers 404 for the messages of a card the viewer cannot see, and keeps an unknown card empty (PM-273)', () => {
    const b = new MockBackend();
    b.messages = [];
    const hidden = b.tasks.find((task) => task.visibility === 'internal');
    expect(hidden).toBeTruthy();
    b.viewerHandle = 'kata';
    const status = (key: string) =>
      b.handle('GET', `${base}/messages`, {}, new URLSearchParams(`taskKey=${key}`)).status;
    expect(status(hidden!.key)).toBe(404);
    expect(status('AC-999')).toBe(200);
    b.viewerHandle = 'owner';
    expect(status(hidden!.key)).toBe(200);
  });
  it('keeps the question with the message that answers it (PM-273)', () => {
    const b = new MockBackend();
    const item = b.inbox.find((candidate) => candidate.id === 'inb_q_ga4')!;
    const before = b.messages.length;
    b.handle('POST', `${base}/inbox/${item.id}/resolve`, { optionId: item.options[0]!.id });
    const answered = b.messages.slice(before).find((message) => message.answer);
    expect(answered?.answer).toMatchObject({ inboxItemId: item.id });
  });
  it('lists the viewer conversations and reads several messages in one request (PM-78)', () => {
    const b = backend();
    b.sendTeamMessage('qa', ['owner'], null, 'qa 1');
    const group = b.sendTeamMessage('owner', ['fe-1', 'kata'], null, 'group');
    const qa2 = b.sendTeamMessage('qa', ['owner'], null, 'qa 2');
    b.sendTeamMessage('fe-1', ['kata'], null, 'not the owner');
    const threads = () => TeamThreadsView.parse(b.handle('GET', `${base}/messages/threads`, {}).body);
    expect(threads().threads.map((t) => [t.peer, t.lastMessage.body, t.unreadCount])).toEqual([
      ['qa', 'qa 2', 2],
      ['kata', 'group', 0],
      ['fe-1', 'group', 0],
    ]);
    expect(threads().unreadCount).toBe(2);
    const events: ServerEvent[] = [];
    const connection = { deliver: (event: ServerEvent) => events.push(event) };
    b.connect(connection);
    b.handleCommand(connection, { type: 'subscribe_project', projectKey: 'AC' });
    const read = TeamMessagesView.parse(
      b.handle('POST', `${base}/messages/read`, { ids: [qa2.id, group.id, 'msg_unknown'] }).body,
    );
    expect(read.messages.map((m) => m.body)).toEqual(['qa 2']);
    expect(read.unreadCount).toBe(1);
    expect(events.filter((e) => e.type === 'team_message')).toHaveLength(1);
    expect(threads().threads[0]).toMatchObject({ peer: 'qa', unreadCount: 1 });
    expect(b.handle('POST', `${base}/messages/read`, { ids: [] }).status).toBe(400);
  });
  it('allows clients to write, denies viewers and rejects invalid data atomically', () => {
    const b = backend();
    b.viewerHandle = 'kata';
    expect(b.handle('POST', `${base}/messages`, { to: ['fe-1'], text: 'Acme request' }).status).toBe(202);
    expect(b.handle('POST', `${base}/members/fe-1/conversation`, {}).status).toBe(403);
    b.findMember('kata')!.role = 'viewer';
    expect(b.handle('POST', `${base}/messages`, { to: ['fe-1'], text: 'Acme request' }).status).toBe(403);
    b.viewerHandle = 'owner';
    for (const body of [
      { to: [], text: 'Acme' },
      { to: ['kata'], text: ' ' },
      { to: ['kata', 'unknown'], text: 'Acme' },
      { to: ['kata'], text: 'Acme', taskKey: 'AC-999' },
    ]) {
      expect(b.handle('POST', `${base}/messages`, body).status).toBeGreaterThanOrEqual(400);
    }
    expect(b.messages).toHaveLength(1);
  });
  it('trims messages and never sends one to its sender', () => {
    const b = backend();
    expect(b.handle('POST', `${base}/messages`, { to: ['owner'], text: 'Acme' })).toMatchObject({
      status: 400,
      body: { error: { code: 'invalid_request', details: { field: 'to' } } },
    });
    expect(
      b.handle('POST', `${base}/messages`, { to: ['kata', 'nobody', 'ghost'], text: 'Acme' }),
    ).toMatchObject({
      status: 404,
      body: { error: { code: 'not_found', details: { ids: ['nobody', 'ghost'] } } },
    });
    const sent = TeamMessage.parse(
      b.handle('POST', `${base}/messages`, { to: ['kata', 'owner'], text: '  Acme notes \n' }).body,
    );
    expect(sent).toMatchObject({ to: ['kata'], body: 'Acme notes' });
    expect(b.messages).toHaveLength(1);
  });
  it('trims a human chat message and refuses a blank one', () => {
    const b = backend();
    const session = Session.parse(b.handle('POST', `${base}/members/fe-1/conversation`, {}).body);
    const path = `${base}/sessions/${session.id}/messages`;
    expect(b.handle('POST', path, { text: ' \n ' })).toMatchObject({
      status: 400,
      body: { error: { code: 'invalid_request', details: { field: 'text' } } },
    });
    expect(b.chats[session.id]).toEqual([]);
    expect(b.handle('POST', path, { text: ' Acme follow-up \n' }).status).toBe(202);
    expect(b.chats[session.id]).toEqual([
      expect.objectContaining({ kind: 'user_text', origin: 'human', text: 'Acme follow-up' }),
    ]);
  });
  // Conversations and schedule runs share one admission check; schedules.test covers every reason.
  it('admits a conversation like any other AI work', () => {
    const b = backend();
    const member = b.config.team.members.find((m) => m.handle === 'fe-1')!;
    if (member.kind !== 'ai') throw new Error('Expected AI member');
    member.capacity = 0;
    expect(b.handle('POST', `${base}/members/fe-1/conversation`, {})).toMatchObject({
      status: 409,
      body: { error: { code: 'member_at_capacity' } },
    });
    expect(b.sessions).toEqual([]);
  });
  it('uses provider-specific plan limits and resumes a stopped general conversation', () => {
    const b = backend();
    const member = b.config.team.members.find((m) => m.handle === 'fe-1')!;
    if (member.kind !== 'ai') throw new Error('Expected AI');
    member.provider = 'codex';
    b.planUsage.weeklyPercent = 99;
    const first = Session.parse(b.handle('POST', `${base}/members/fe-1/conversation`, {}).body);
    expect(first.provider).toBe('codex');
    b.handle('POST', `${base}/sessions/${first.id}/stop`, {});
    b.handle('POST', `${base}/messages`, { to: ['fe-1'], text: 'Acme resume' });
    const resumed = Session.parse(b.handle('POST', `${base}/members/fe-1/conversation`, {}).body);
    expect(resumed.id).toBe(first.id);
    expect(b.chats[first.id]?.filter((c) => c.kind === 'team_message')).toHaveLength(1);
  });
  it('returns both member profiles, hides human email and AI private data from clients', () => {
    const b = new MockBackend();
    const human = MemberProfile.parse(b.handle('GET', `${base}/members/bence/profile`, {}).body);
    expect(human.email).toBe('bence@acme.test');
    expect(human.member.kind).toBe('human');
    const ai = MemberProfile.parse(b.handle('GET', `${base}/members/fe-1/profile`, {}).body);
    expect(ai.sessions.length).toBeGreaterThan(0);
    expect(ai.tasks.length).toBeGreaterThan(0);
    expect(ai.duties).toContain('implementation');
    b.memories['fe-1'] = 'Acme fixtures are fictional.';
    expect(b.handle('GET', `${base}/members/fe-1/memories`, {}).body).toEqual({
      memory: 'Acme fixtures are fictional.',
    });
    b.viewerHandle = 'kata';
    expect(
      MemberProfile.parse(b.handle('GET', `${base}/members/bence/profile`, {}).body).email,
    ).toBeUndefined();
    expect(MemberProfile.parse(b.handle('GET', `${base}/members/fe-1/profile`, {}).body).sessions).toEqual(
      [],
    );
    expect(b.handle('GET', `${base}/members/fe-1/memories`, {}).status).toBe(403);
  });
  it('updates human access and roles and removes a human as an admin', () => {
    const b = backend();
    expect(b.handle('PATCH', `${base}/members/bence`, { access: 'admin', roles: ['support'] }).status).toBe(
      200,
    );
    expect(b.findMember('bence')).toMatchObject({ role: 'admin', roles: ['support'] });
    expect(b.handle('DELETE', `${base}/members/bence/remove`, {}).status).toBe(204);
    expect(b.handle('GET', `${base}/members/bence/profile`, {}).status).toBe(404);
    expect(b.handle('DELETE', `${base}/members/owner/remove`, {}).status).toBe(403);
  });
});
