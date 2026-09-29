import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_ROLE_IDS, RolesView, validateProjectConfig } from '@projectman/shared';
import { MockBackend } from './backend';
import { startSimulation } from './simulation';

const role = {
  id: 'data_steward',
  name: 'Acme steward',
  summary: 'Keeps reference data clean.',
  notTheirJob: 'Does not change schemas.',
  holders: 'both',
  instructions: 'Check reference records.',
};
const base = '/api/projects/AC';
function errorCode(response: { body?: unknown }) {
  return (response.body as { error: { code: string } }).error.code;
}

afterEach(() => vi.useRealTimers());

describe('mock role catalogue and member mutations', () => {
  it('preserves catalogue order and appends custom roles', () => {
    const backend = new MockBackend();
    expect(backend.handle('POST', `${base}/roles`, role).status).toBe(201);
    const catalogue = RolesView.parse(backend.handle('GET', `${base}/roles`, undefined).body);
    expect(catalogue.roles.map((entry) => entry.id)).toEqual([...BUILT_IN_ROLE_IDS, role.id]);
    expect(catalogue.roles.at(-1)).toHaveProperty('instructions', role.instructions);
  });
  it('rejects invalid roles, holder mismatches and member kinds without changing data', () => {
    const backend = new MockBackend();
    expect(errorCode(backend.handle('POST', `${base}/members`, { role: 'missing_role' }))).toBe(
      'unknown_role',
    );
    expect(errorCode(backend.handle('POST', `${base}/members`, { role: 'operator' }))).toBe(
      'role_not_for_ai',
    );
    expect(backend.handle('PATCH', `${base}/members/owner`, { roles: ['watchdog'] }).status).toBe(200);
    expect(errorCode(backend.handle('PATCH', `${base}/members/owner`, { roles: ['missing_role'] }))).toBe(
      'unknown_role',
    );
    expect(errorCode(backend.handle('PATCH', `${base}/members/owner`, { model: 'sonnet' }))).toBe(
      'not_ai_member',
    );
    expect(errorCode(backend.handle('PATCH', `${base}/members/qa`, { roles: ['qa'] }))).toBe(
      'not_human_member',
    );
    expect(errorCode(backend.handle('POST', `${base}/roles`, { ...role, id: 'qa' }))).toBe(
      'custom_role_shadows_builtin',
    );
    backend.handle('POST', `${base}/roles`, role);
    expect(errorCode(backend.handle('POST', `${base}/roles`, role))).toBe('duplicate_role');
    expect(
      errorCode(backend.handle('PUT', `${base}/roles/data_steward`, { ...role, id: 'other_role' })),
    ).toBe('role_id_mismatch');
    expect(errorCode(backend.handle('DELETE', `${base}/roles/qa`, undefined))).toBe('builtin_role');
    expect(errorCode(backend.handle('PUT', `${base}/roles/qa`, { ...role, id: 'qa' }))).toBe('builtin_role');
    expect(validateProjectConfig(backend.config).filter((i) => i.severity !== 'warning')).toEqual([]);
  });
  it('reports excluded holders and configured temp workers', () => {
    const backend = new MockBackend();
    backend.handle('POST', `${base}/roles`, role);
    backend.handle('POST', `${base}/members`, { role: role.id, handle: 'acme-steward' });
    backend.handle('PATCH', `${base}/members/owner`, { roles: ['operator', role.id] });
    expect(backend.handle('DELETE', `${base}/roles/data_steward`, undefined)).toMatchObject({
      status: 409,
      body: { error: { code: 'role_in_use', details: { members: ['owner', 'acme-steward'] } } },
    });
    expect(backend.handle('PUT', `${base}/roles/data_steward`, { ...role, holders: 'human' })).toMatchObject({
      status: 409,
      body: { error: { details: { members: ['acme-steward'] } } },
    });
    backend.config.team.limits.tempWorkers.role = role.id;
    expect(backend.handle('PUT', `${base}/roles/data_steward`, { ...role, holders: 'human' })).toMatchObject({
      body: { error: { details: { tempWorkers: true } } },
    });
  });
  it('opens the catalogue to members and restricts mutations to owners and admins', () => {
    const backend = new MockBackend();
    backend.viewerHandle = 'kata';
    expect(backend.handle('GET', `${base}/roles`, undefined).status).toBe(200);
    expect(backend.handle('POST', `${base}/roles`, role).status).toBe(403);
    expect(backend.handle('PATCH', `${base}/members/owner`, { roles: [] }).status).toBe(403);
    expect(backend.handle('POST', `${base}/tasks/AC-20/cancel`, {}).status).toBe(403);
    expect(backend.handle('PATCH', `${base}/tasks/AC-20`, { assignee: null }).status).toBe(403);
    backend.findMember('kata')!.role = 'admin';
    const admin = backend.config.team.members.find((m) => m.handle === 'kata')!;
    if (admin.kind === 'human') admin.access = 'admin';
    expect(backend.handle('POST', `${base}/roles`, role).status).toBe(201);
  });
});

describe('mock task lifecycle', () => {
  it('returns realistic errors and retains previous assignment in the timeline', () => {
    const backend = new MockBackend();
    expect(errorCode(backend.handle('POST', `${base}/tasks/AC-16/cancel`, {}))).toBe('task_closed');
    expect(errorCode(backend.handle('POST', `${base}/tasks/AC-20/reopen`, {}))).toBe('task_not_cancelled');
    expect(errorCode(backend.handle('PATCH', `${base}/tasks/AC-20`, { assignee: 'missing-member' }))).toBe(
      'unknown_member',
    );
    expect(backend.handle('PATCH', `${base}/tasks/AC-20`, { assignee: null })).toMatchObject({
      status: 409,
      body: { error: { code: 'task_session_live', details: { sessionId: 'ses_ac20_be1' } } },
    });
    backend.handle('POST', `${base}/sessions/ses_ac20_be1/stop`, {});
    expect(backend.handle('PATCH', `${base}/tasks/AC-20`, { assignee: null }).status).toBe(200);
    expect(backend.timeline.at(-1)).toMatchObject({
      type: 'task_assigned',
      data: { previous: 'be-1', assignee: null },
    });
  });
  it('drops queued replies and resolved permission work after cancellation', () => {
    vi.useFakeTimers();
    const backend = new MockBackend();
    backend.handle('POST', `${base}/sessions/ses_ac20_be1/messages`, { text: 'Review the Acme backup.' });
    backend.handle('POST', `${base}/tasks/AC-20/cancel`, {});
    backend.handle('POST', `${base}/tasks/AC-20/reopen`, {});
    backend.handle('POST', `${base}/inbox/inb_perm_push/resolve`, { optionId: 'allow' });
    vi.advanceTimersByTime(300);
    backend.handle('POST', `${base}/tasks/AC-21/cancel`, {});
    vi.advanceTimersByTime(5000);
    expect(backend.findSession('ses_ac20_be1')?.state).toBe('exited');
    expect(backend.findSession('ses_ac21_fe1')?.state).toBe('exited');
    expect(backend.findTask('AC-21')).toMatchObject({ status: 'cancelled', stageId: 'qa' });
  });
  it('cancels every live task session and prevents the demo from reviving it', () => {
    vi.useFakeTimers();
    const backend = new MockBackend();
    startSimulation(backend);
    backend.handle('POST', `${base}/tasks/AC-25/cancel`, { reason: 'Acme scope changed.' });
    backend.handle('POST', `${base}/tasks/AC-18/cancel`, {});
    backend.handle('POST', `${base}/tasks/AC-21/cancel`, {});
    vi.advanceTimersByTime(60_000);
    expect(backend.findTask('AC-25')?.status).toBe('cancelled');
    expect(backend.findSession('ses_ac25_cr')?.state).toBe('exited');
    expect(backend.findSession('ses_ac18_qa')?.state).toBe('exited');
    expect(backend.inbox.find((item) => item.id === 'inb_perm_push')?.state).toBe('cancelled');
    expect(backend.handle('POST', `${base}/tasks/AC-25/reopen`, {}).status).toBe(200);
    expect(backend.findTask('AC-25')).toMatchObject({
      status: 'active',
      assignee: null,
      closedAt: null,
      stageId: 'code_review',
    });
  });
});

describe('mock stage gates', () => {
  it('blocks skipped checks and open PRs, but creates deduplicated approval decisions for merged PRs', () => {
    const backend = new MockBackend();
    expect(errorCode(backend.handle('PATCH', `${base}/tasks/AC-20`, { stageId: 'client_test' }))).toBe(
      'gate_blocked',
    );
    expect(backend.findTask('AC-20')?.stageId).toBe('dev');
    expect(errorCode(backend.handle('PATCH', `${base}/tasks/AC-27`, { stageId: 'release' }))).toBe(
      'gate_blocked',
    );
    const task = backend.findTask('AC-27')!;
    backend.updateTask(task.key, { links: task.links.map((link) => ({ ...link, state: 'merged' })) });
    expect(errorCode(backend.handle('PATCH', `${base}/tasks/AC-27`, { stageId: 'release' }))).toBe(
      'approval_requested',
    );
    expect(errorCode(backend.handle('PATCH', `${base}/tasks/AC-27`, { stageId: 'release' }))).toBe(
      'approval_requested',
    );
    expect(backend.findTask(task.key)?.stageId).toBe('merge');
    expect(
      backend.inbox.filter(
        (item) => item.taskKey === task.key && item.kind === 'decision' && item.state === 'open',
      ),
    ).toHaveLength(1);
  });
});
