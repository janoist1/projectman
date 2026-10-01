import { describe, expect, it } from 'vitest';
import { Session } from '@projectman/shared';
import { MockBackend } from './backend';

const base = '/api/projects/AC';
const onLeave = { status: 409, body: { error: { code: 'member_on_leave' } } };

function setup() {
  const b = new MockBackend();
  b.sessions = [];
  b.messages = [];
  b.planUsage.fiveHourPercent = 0;
  b.planUsage.weeklyPercent = 0;
  return b;
}

const leave = (b: MockBackend, handle: string, value: boolean) =>
  b.handle('PATCH', `${base}/members/${handle}`, { onLeave: value });

describe('mock members on leave', () => {
  it('shows the leave on the member and takes it back', () => {
    const b = setup();
    const sent = leave(b, 'fe-1', true);
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ handle: 'fe-1', onLeave: true });
    expect(memberOfBoard(b, 'fe-1')).toMatchObject({ onLeave: true });
    const back = leave(b, 'fe-1', false);
    expect(back.body).not.toHaveProperty('onLeave');
    expect(b.config.team.members.find((m) => m.handle === 'fe-1')).not.toHaveProperty('onLeave');
  });

  it('applies to AI members only', () => {
    const b = setup();
    expect(leave(b, b.viewerHandle, true)).toMatchObject({
      status: 400,
      body: { error: { code: 'not_ai_member' } },
    });
  });

  it('stops the member sessions that run when it is sent on leave', () => {
    const b = setup();
    b.tasks = [];
    const session = Session.parse(b.handle('POST', `${base}/members/fe-1/conversation`, {}).body);
    leave(b, 'fe-1', true);
    expect(b.sessions.find((s) => s.id === session.id)?.state).toBe('exited');
  });

  it('starts nothing for a member on leave: not a conversation, not a task, not a schedule run', () => {
    const b = setup();
    const task = b.tasks[0]!;
    const before = structuredClone(task);
    leave(b, 'fe-1', true);
    expect(b.handle('POST', `${base}/members/fe-1/conversation`, {})).toMatchObject(onLeave);
    expect(b.handle('POST', `${base}/tasks/${task.key}/start`, { assignee: 'fe-1' })).toMatchObject(onLeave);
    expect(task).toEqual(before);
    expect(b.sessions).toHaveLength(0);

    const member = b.config.team.members.find((m) => m.handle === 'fe-1');
    if (member?.kind === 'ai') member.schedule = { cron: '0 9 * * *', prompt: 'Check the fictional board.' };
    expect(b.handle('POST', `${base}/members/fe-1/schedule/run`, {})).toMatchObject(onLeave);
    expect(b.scheduleRuns.at(-1)).toMatchObject({ status: 'skipped', reason: 'member_on_leave' });
    expect(b.sessions).toHaveLength(0);
  });

  it('does not pick a member on leave for a task, and does not let one be named the assignee', () => {
    const b = setup();
    const task = b.tasks.find((t) => t.assignee === null && t.status === 'active')!;
    leave(b, 'fe-1', true);
    expect(b.handle('PATCH', `${base}/tasks/${task.key}`, { assignee: 'fe-1' })).toMatchObject(onLeave);
    b.handle('POST', `${base}/tasks/${task.key}/start`, {});
    expect(b.tasks.find((t) => t.key === task.key)?.assignee).not.toBe('fe-1');
  });

  it('keeps messages for a member on leave until it is called back', () => {
    const b = setup();
    b.tasks = [];
    leave(b, 'fe-1', true);
    expect(b.handle('POST', `${base}/messages`, { to: ['fe-1'], text: 'Fictional question' }).status).toBe(
      202,
    );
    expect(b.handle('POST', `${base}/members/fe-1/conversation`, {})).toMatchObject(onLeave);
    expect(b.messages[0]?.deliveredAt).toBeNull();
    leave(b, 'fe-1', false);
    expect(b.handle('POST', `${base}/members/fe-1/conversation`, {}).status).toBe(202);
    expect(b.messages[0]?.deliveredAt).toBeTruthy();
  });
});

describe('mock cap on concurrent AI sessions', () => {
  it('refuses at the cap the project names', () => {
    const b = setup();
    b.tasks = [];
    b.config.team.limits.maxConcurrentAi = 1;
    startWorking(b, 'fe-1');
    expect(b.handle('POST', `${base}/members/be-1/conversation`, {})).toMatchObject({
      status: 409,
      body: { error: { code: 'ai_limit_reached' } },
    });
  });

  it('puts no cap on the work when the project names none', () => {
    const b = setup();
    b.tasks = [];
    delete b.config.team.limits.maxConcurrentAi;
    startWorking(b, 'fe-1');
    startWorking(b, 'be-1');
    expect(b.sessions.filter((s) => s.state === 'working')).toHaveLength(2);
  });

  it('removes the cap with a null patch', () => {
    const b = setup();
    const version = (b.handle('GET', `${base}/config`, {}).body as { version: string }).version;
    const patched = b.handle('PATCH', `${base}/config`, {
      baseVersion: version,
      limits: { maxConcurrentAi: null },
    });
    expect(patched.status).toBe(200);
    expect(b.config.team.limits).not.toHaveProperty('maxConcurrentAi');
  });
});

/** A conversation of the member that is mid-turn, which counts against the cap. */
function startWorking(b: MockBackend, handle: string): void {
  const started = b.handle('POST', `${base}/members/${handle}/conversation`, {});
  expect(started.status).toBe(202);
  b.updateSession(Session.parse(started.body).id, { state: 'working' });
}

function memberOfBoard(b: MockBackend, handle: string) {
  const members = (b.handle('GET', `${base}/members`, {}).body as Array<{ handle: string }>) ?? [];
  return members.find((m) => m.handle === handle);
}
