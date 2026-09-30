import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@projectman/shared';
import { createRepositories, openDatabase } from '../src/db';
import type { Repositories } from '../src/db';
import { createDomainContext, createEventBus } from '../src/domain';
import type { DomainContext } from '../src/domain';
import { capturingLogger } from './helpers/fakes';

describe('unit of work', () => {
  let repos: Repositories;
  let ctx: DomainContext;
  let published: string[];

  const event = (version: string): ServerEvent => ({ type: 'config_changed', projectKey: 'AR', version });
  const project = (key: string) => ({
    key,
    name: key,
    templateId: null,
    configVersion: 'v1',
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
  });

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    const bus = createEventBus();
    published = [];
    bus.subscribe((e) => published.push(e.type === 'config_changed' ? e.version : e.type));
    ctx = createDomainContext({ repos, bus, logger: capturingLogger().logger, now: () => new Date() });
  });
  afterEach(() => repos.db.close());

  it('publishes its events after the writes commit', () => {
    const result = ctx.unitOfWork(() => {
      repos.projects.insert(project('AR'));
      ctx.bus.publish(event('one'));
      ctx.bus.publish(event('two'));
      expect(published).toEqual([]);
      return 42;
    });
    expect(result).toBe(42);
    expect(published).toEqual(['one', 'two']);
    expect(repos.projects.get('AR')).not.toBeNull();
  });

  it('rolls back the writes and drops the events when it fails', () => {
    expect(() =>
      ctx.unitOfWork(() => {
        repos.projects.insert(project('AR'));
        ctx.bus.publish(event('lost'));
        throw new Error('refused');
      }),
    ).toThrow('refused');
    expect(published).toEqual([]);
    expect(repos.projects.get('AR')).toBeNull();
    // Outside a unit of work events go out at once.
    ctx.bus.publish(event('now'));
    expect(published).toEqual(['now']);
  });

  it('nests: an inner unit publishes with the outer commit, a failed inner one leaves the outer intact', () => {
    ctx.unitOfWork(() => {
      repos.projects.insert(project('AR'));
      ctx.unitOfWork(() => {
        repos.projects.insert(project('XY'));
        ctx.bus.publish(event('inner'));
      });
      expect(published).toEqual([]);
      try {
        ctx.unitOfWork(() => {
          repos.projects.insert(project('ZZ'));
          ctx.bus.publish(event('failed'));
          throw new Error('inner failure');
        });
      } catch {
        // the outer unit goes on
      }
      ctx.bus.publish(event('outer'));
    });
    expect(published).toEqual(['inner', 'outer']);
    expect(repos.projects.list().map((p) => p.key)).toEqual(['AR', 'XY']);
  });

  it('refuses asynchronous work, which a transaction cannot span', () => {
    const asyncWork = (async () => {
      repos.projects.insert(project('AR'));
    }) as unknown as () => void;
    expect(() => ctx.unitOfWork(asyncWork)).toThrow(/promise/);
    expect(repos.projects.get('AR')).toBeNull();
  });
});
