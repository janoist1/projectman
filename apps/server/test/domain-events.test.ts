import { describe, expect, it } from 'vitest';
import type { Task } from '@projectman/shared';
import { createDomainEvents } from '../src/domain';
import { capturingLogger } from './helpers/fakes';

const cancelled = { key: 'AR-1', projectKey: 'AR' } as Task;

describe('domain events', () => {
  it('runs listeners in order, the synchronous ones before emit returns', async () => {
    const events = createDomainEvents(capturingLogger().logger);
    const calls: string[] = [];
    events.on('task_cancelled', () => void calls.push('first'));
    events.on('task_cancelled', async () => {
      calls.push('second');
      await Promise.resolve();
      calls.push('second done');
    });
    events.on('task_cancelled', () => void calls.push('third'));
    const emitted = events.emit('task_cancelled', cancelled);
    expect(calls).toEqual(['first', 'second']);
    await emitted;
    expect(calls).toEqual(['first', 'second', 'second done', 'third']);
  });

  it('logs a failing listener and runs the others', async () => {
    const log = capturingLogger();
    const events = createDomainEvents(log.logger);
    const calls: string[] = [];
    events.on('task_cancelled', () => {
      throw new Error('fictional failure');
    });
    events.on('task_cancelled', async () => {
      throw new Error('fictional async failure');
    });
    events.on('task_cancelled', (task) => void calls.push(task.key));
    await expect(events.emit('task_cancelled', cancelled)).resolves.toBeUndefined();
    expect(calls).toEqual(['AR-1']);
    expect(log.errors).toHaveLength(2);
    expect(JSON.stringify(log.errors)).toContain('domain event listener failed');
  });

  it('removes a listener', async () => {
    const events = createDomainEvents(capturingLogger().logger);
    const calls: string[] = [];
    const off = events.on('task_cancelled', () => void calls.push('heard'));
    off();
    await events.emit('task_cancelled', cancelled);
    expect(calls).toEqual([]);
  });
});
