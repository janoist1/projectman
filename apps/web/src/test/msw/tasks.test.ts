import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '../../mocks/backend';
import { createMockFetch } from '../mockProject';
import { apiFailure, takeContractViolations } from './contract';
import { onTaskComment, onTaskDetail, onTaskLabels, onTaskUpdate } from './tasks';

const path = '/api/projects/AC/tasks/AC-20';
const send = (backend: MockBackend, suffix: string, method: string, body: unknown) =>
  createMockFetch(backend)(`${path}${suffix}`, { method, body: JSON.stringify(body) });

describe('task mock contracts', () => {
  it('rejects an invalid static response at registration', () => {
    expect(() => onTaskDetail('AC-20', { task: {} } as never)).toThrow('Task response');
  });

  it.each([
    ['PATCH', '', { title: '' }],
    ['POST', '/comments', { text: '' }],
    ['POST', '/labels', { add: [] }],
  ])(
    'records an invalid %s %s request even if the caller handles the error',
    async (method, suffix, body) => {
      expect((await send(new MockBackend(), suffix, method, body)).status).toBe(400);
      expect(takeContractViolations()).toHaveLength(1);
    },
  );

  it('records an invalid callback response', async () => {
    onTaskUpdate('AC-20', () => ({ title: 'Incomplete' }) as never);
    expect((await send(new MockBackend(), '', 'PATCH', { title: 'Valid' })).status).toBe(500);
    expect(takeContractViolations()).toHaveLength(1);
  });

  it('records malformed JSON before the caller handles the error', async () => {
    const response = await createMockFetch(new MockBackend())(path, { method: 'PATCH', body: '{invalid' });
    expect(response.status).toBe(400);
    expect(takeContractViolations()).toHaveLength(1);
  });

  it('records an invalid default response', async () => {
    const backend = new MockBackend();
    backend.findTask('AC-20')!.title = undefined as never;
    expect((await createMockFetch(backend)(path)).status).toBe(500);
    expect(takeContractViolations()).toHaveLength(1);
  });

  it('rejects an invalid failure status', () => {
    expect(() => onTaskLabels('AC-20', apiFailure(200, 'invalid_status'))).toThrow('Failure status');
  });

  it('uses the test response before the default and exposes the parsed request', async () => {
    const reply = vi.fn(() => apiFailure(409, 'task_session_live'));
    onTaskUpdate('AC-20', reply);
    const backend = new MockBackend();
    expect((await send(backend, '', 'PATCH', { repo: 'admin' })).status).toBe(409);
    expect(reply).toHaveBeenCalledWith({ taskKey: 'AC-20', body: { repo: 'admin' } });
    expect(backend.findTask('AC-20')!.repo).toBe('infra');
  });

  it('restores default handlers after the previous test', async () => {
    const backend = new MockBackend();
    const emit = vi.fn();
    const connection = { deliver: emit };
    backend.connect(connection);
    backend.handleCommand(connection, { type: 'subscribe_project', projectKey: 'AC' });
    expect((await send(backend, '', 'PATCH', { repo: 'admin' })).status).toBe(200);
    expect(backend.findTask('AC-20')!.repo).toBe('admin');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'task_upserted' }));
  });

  it('keeps the default state separate for multiple backends in one test', async () => {
    const first = new MockBackend();
    const second = new MockBackend();
    first.updateTask('AC-20', { title: 'First backend' });
    expect((await (await createMockFetch(first)(path)).json()).task.title).toBe('First backend');
    expect((await (await createMockFetch(second)(path)).json()).task.title).toBe(
      second.findTask('AC-20')!.title,
    );
  });

  it('serves comment overrides with their status', async () => {
    const backend = new MockBackend();
    onTaskComment('AC-20', backend.taskDetail(backend.findTask('AC-20')!));
    expect((await send(backend, '/comments', 'POST', { text: 'Note' })).status).toBe(201);
  });
});
