import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { pullRequest } from './helpers/fakes';

describe('pull request snapshots of a task', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness();
  });
  afterEach(() => h.cleanup());

  it.each([
    ['success', 'passing'],
    ['failure', 'failing'],
    ['pending', 'pending'],
    ['none', null],
  ] as const)('maps polled %s checks to %s and preserves GitHub fields', async (checks, expected) => {
    const { domain } = h;
    const task = await domain.tasks.create('AR', { title: 'Fictional login form' }, OWNER_ACTOR);
    domain.tasks.addLink('AR', task.key, { kind: 'pull_request', repo: 'acme/web', ref: '7' }, OWNER_ACTOR);
    expect(domain.tasks.detail('AR', task.key).pullRequests).toEqual([
      {
        repo: 'acme/web',
        number: 7,
        url: null,
        title: null,
        state: null,
        checks: null,
        reviewDecision: null,
        additions: null,
        deletions: null,
      },
    ]);
    await domain.githubSync.handleChange(pullRequest({ checks, reviewDecision: 'approved' }));
    expect(domain.tasks.detail('AR', task.key).pullRequests).toEqual([
      {
        repo: 'acme/web',
        number: 7,
        url: 'https://github.com/acme/web/pull/7',
        title: 'Add login page',
        state: 'open',
        checks: expected,
        reviewDecision: 'approved',
        additions: 10,
        deletions: 2,
      },
    ]);
    const published = vi.fn();
    domain.bus.subscribe(published);
    await domain.githubSync.handleChange(
      pullRequest({ checks, reviewDecision: 'changes_requested', additions: 99 }),
    );
    expect(domain.tasks.detail('AR', task.key).pullRequests[0]).toMatchObject({
      reviewDecision: 'changes_requested',
      additions: 99,
    });
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ type: 'task_upserted' }));
  });
});
