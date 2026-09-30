import { describe, expect, it } from 'vitest';
import { Session } from '@projectman/shared';
import { MockBackend } from './backend';

const base = '/api/projects/AC';
const disabled = { status: 409, body: { error: { code: 'ai_disabled' } } };

function setup() {
  const b = new MockBackend();
  b.sessions = [];
  b.messages = [];
  b.planUsage.fiveHourPercent = 0;
  b.planUsage.weeklyPercent = 0;
  return b;
}

describe('mock project AI switch', () => {
  it('refuses task starts without changing the task', () => {
    const b = setup();
    const task = b.tasks[0]!;
    const before = structuredClone(task);
    b.config.team.limits.aiEnabled = false;
    expect(b.handle('POST', `${base}/tasks/${task.key}/start`, { assignee: 'fe-1' })).toMatchObject(disabled);
    expect(task).toEqual(before);
    expect(b.sessions).toHaveLength(0);
  });

  it('allows running conversations and replies but refuses stopped-session replies and resumes', () => {
    const b = setup();
    b.tasks = [];
    const session = Session.parse(b.handle('POST', `${base}/members/fe-1/conversation`, {}).body);
    b.config.team.limits.aiEnabled = false;
    expect(b.handle('POST', `${base}/members/fe-1/conversation`, {}).body).toEqual(session);
    expect(
      b.handle('POST', `${base}/sessions/${session.id}/messages`, { text: 'Fictional follow-up' }).status,
    ).toBe(202);
    b.handle('POST', `${base}/sessions/${session.id}/stop`, {});
    expect(
      b.handle('POST', `${base}/sessions/${session.id}/messages`, { text: 'Fictional reply' }),
    ).toMatchObject(disabled);
    expect(b.handle('POST', `${base}/members/fe-1/conversation`, {})).toMatchObject(disabled);
    expect(b.sessions).toHaveLength(1);
    expect(b.sessions[0]?.state).toBe('exited');
  });

  it('keeps queued messages until a conversation is allowed to resume', () => {
    const b = setup();
    b.tasks = [];
    b.config.team.limits.aiEnabled = false;
    expect(
      b.handle('POST', `${base}/messages`, { to: ['fe-1'], text: 'Fictional queued question' }).status,
    ).toBe(202);
    expect(b.handle('POST', `${base}/members/fe-1/conversation`, {})).toMatchObject(disabled);
    expect(b.messages[0]?.deliveredAt).toBeNull();
    b.config.team.limits.aiEnabled = true;
    expect(b.handle('POST', `${base}/members/fe-1/conversation`, {}).status).toBe(202);
    expect(b.messages[0]?.deliveredAt).toBeTruthy();
    expect(b.sessions).toHaveLength(1);
  });
});
