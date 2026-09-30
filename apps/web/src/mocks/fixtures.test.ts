import {
  BoardView,
  ChatItem,
  ConfigView,
  InboxItem,
  InboxView,
  MemberView,
  Me,
  ProjectConfig,
  ServerEvent,
  Session,
  SessionDetail,
  Task,
  TaskDetail,
  TeamMessage,
  TemplateSummary,
  TimelineEvent,
  validateProjectConfig,
} from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { MockBackend } from './backend';
import type { MockConnection } from './backend';
import * as fixtures from './fixtures';

describe('mock fixtures satisfy the shared contracts', () => {
  it('validates every fixture against its schema', () => {
    const check = (
      schema: { safeParse(data: unknown): { success: boolean } },
      list: unknown[],
      name: string,
    ) => {
      const bad = list.filter((entry) => !schema.safeParse(entry).success);
      expect(bad, name).toEqual([]);
    };
    check(Task, fixtures.tasks, 'tasks');
    check(MemberView, fixtures.members, 'members');
    check(Session, fixtures.sessions, 'sessions');
    check(InboxItem, fixtures.inbox, 'inbox');
    check(TeamMessage, fixtures.teamMessages, 'messages');
    check(TimelineEvent, fixtures.timeline, 'timeline');
    check(ChatItem, Object.values(fixtures.chats).flat(), 'chat');
    check(TemplateSummary, fixtures.templates, 'templates');
  });

  it('builds a configuration that holds every invariant', () => {
    const config = ProjectConfig.parse(fixtures.buildConfig());
    expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([]);
  });

  it('has tasks in every pipeline stage', () => {
    const stages = new Set(fixtures.tasks.map((task) => task.stageId));
    expect(
      fixtures
        .buildConfig()
        .pipeline.stages.map((stage) => stage.id)
        .filter((id) => !stages.has(id)),
    ).toEqual([]);
  });
});

describe('MockBackend', () => {
  it('serves responses that match the DTOs', () => {
    const backend = new MockBackend();
    expect(BoardView.safeParse(backend.handle('GET', '/api/projects/AC/board', undefined).body).success).toBe(
      true,
    );
    expect(
      TaskDetail.safeParse(backend.handle('GET', '/api/projects/AC/tasks/AC-21', undefined).body).success,
    ).toBe(true);
    expect(
      SessionDetail.safeParse(backend.handle('GET', '/api/projects/AC/sessions/ses_ac21_fe1', undefined).body)
        .success,
    ).toBe(true);
    expect(InboxView.safeParse(backend.handle('GET', '/api/projects/AC/inbox', undefined).body).success).toBe(
      true,
    );
    expect(
      ConfigView.safeParse(backend.handle('GET', '/api/projects/AC/config', undefined).body).success,
    ).toBe(true);
    expect(backend.handle('GET', '/api/projects/XX/board', undefined).status).toBe(404);
  });

  it('serves membership, provider snapshots and PR details and emits member changes', () => {
    const backend = new MockBackend();
    const events: ServerEvent[] = [];
    const connection: MockConnection = { deliver: (event) => events.push(event) };
    backend.connect(connection);
    backend.handleCommand(connection, { type: 'subscribe_project', projectKey: 'AC' });
    expect(Me.parse(backend.handle('GET', '/api/me', undefined).body).projects).toMatchObject([
      { key: 'AC', access: 'owner' },
    ]);
    const board = BoardView.parse(backend.handle('GET', '/api/projects/AC/board', undefined).body);
    expect(Object.keys(board.planUsageByProvider).sort()).toEqual(['claude', 'codex']);
    expect(board.members.find((member) => member.handle === 'be-1')).toMatchObject({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      permissionMode: 'acceptEdits',
    });
    expect(
      TaskDetail.parse(backend.handle('GET', '/api/projects/AC/tasks/AC-21', undefined).body).pullRequests[0],
    ).toMatchObject({ checks: 'passing', reviewDecision: 'approved', additions: 42, deletions: 8 });
    const hired = MemberView.parse(
      backend.handle('POST', '/api/projects/AC/members', {
        role: 'qa',
        provider: 'codex',
        model: 'fictional-model',
      }).body,
    );
    backend.handle('PATCH', `/api/projects/AC/members/${hired.handle}`, { model: 'fictional-new-model' });
    backend.handle('DELETE', `/api/projects/AC/members/${hired.handle}`, {});
    expect(events.filter((event) => event.type === 'member_changed')).toEqual([
      expect.objectContaining({
        handle: hired.handle,
        member: expect.objectContaining({ provider: 'codex', model: 'fictional-model' }),
      }),
      expect.objectContaining({
        handle: hired.handle,
        member: expect.objectContaining({ model: 'fictional-new-model' }),
      }),
      expect.objectContaining({ handle: hired.handle, member: null }),
    ]);
    expect(events.every((event) => ServerEvent.safeParse(event).success)).toBe(true);
  });

  it('asks for a login when the user is logged out', () => {
    const backend = new MockBackend('login');
    expect(backend.handle('GET', '/api/me', undefined).status).toBe(401);
    expect(
      backend.handle('POST', '/api/auth/login', { email: 'owner@acme.test', password: 'secret' }).status,
    ).toBe(200);
    expect(backend.handle('GET', '/api/me', undefined).status).toBe(200);
  });

  it('resolves a permission and publishes valid events', () => {
    const backend = new MockBackend();
    const events: ServerEvent[] = [];
    const connection: MockConnection = { deliver: (event) => events.push(event) };
    backend.connect(connection);
    backend.handleCommand(connection, { type: 'subscribe_project', projectKey: 'AC' });

    expect(
      backend.handle('POST', '/api/projects/AC/inbox/inb_q_ga4/resolve', { optionId: 'answer' }).status,
    ).toBe(400);
    const response = backend.handle('POST', '/api/projects/AC/inbox/inb_perm_push/resolve', {
      optionId: 'allow',
    });
    expect(response.status).toBe(200);

    expect(events.every((event) => ServerEvent.safeParse(event).success)).toBe(true);
    const types = new Set(events.map((event) => event.type));
    expect([...types]).toEqual(
      expect.arrayContaining(['inbox_upserted', 'timeline_appended', 'session_upserted']),
    );
    expect(
      backend.handle('POST', '/api/projects/AC/inbox/inb_perm_push/resolve', { optionId: 'allow' }).status,
    ).toBe(409);
  });
});
