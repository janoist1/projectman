import { afterEach, describe, expect, it } from 'vitest';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { FakeRuntimeBoundary } from './helpers/fake-runtime-boundary';

/** Session starts behind the managed VM boundary (PM-140), with the fake runner. */
describe('sessions behind the VM boundary', () => {
  let h: DomainHarness;
  let boundary: FakeRuntimeBoundary;
  afterEach(() => h.cleanup());

  async function setUp() {
    boundary = new FakeRuntimeBoundary();
    h = await createDomainHarness({ runtimeBoundary: boundary });
    await h.domain.tasks.create('AR', { title: 'Work' }, OWNER_ACTOR);
  }

  it('starts no session while the boundary does not hold, and says why', async () => {
    await setUp();
    boundary.ready = false;
    boundary.problems = ['readiness:gate-loaded', 'egress_proxy_down'];
    await expect(
      h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER }),
    ).rejects.toMatchObject({
      code: 'runtime_boundary_not_ready',
      status: 503,
      details: { problems: ['readiness:gate-loaded', 'egress_proxy_down'] },
    });
    expect(h.runner.started).toEqual([]);
  });

  it('runs a session in its member’s worker home with egress credentials that map back to it', async () => {
    await setUp();
    const started = await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    const spec = h.runner.lastStarted();
    expect(spec.cwd).toBe('/var/lib/projectman-work/dev-1/sessions/AR');
    expect(boundary.runs).toEqual([
      {
        member: 'dev-1',
        program: 'mkdir',
        args: ['-p', '-m', '0750', '--', '/var/lib/projectman-work/dev-1/sessions/AR'],
        cwd: '/var/lib/projectman-work/dev-1',
      },
    ]);
    expect(spec.egressToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(h.domain.sessions.resolveEgressToken(spec.egressToken!)).toEqual({
      sessionId: started.session!.id,
      projectKey: 'AR',
      member: 'dev-1',
      taskKey: 'AR-1',
    });
    // The MCP token is another one: proxy credentials grant no team tools.
    expect(h.domain.sessions.resolveToken(spec.egressToken!)).toBeNull();
    await h.domain.sessions.stop('AR', started.session!.id);
    expect(h.domain.sessions.resolveEgressToken(spec.egressToken!)).toBeNull();
  });

  it('fails the start when the worker cannot prepare its directory', async () => {
    await setUp();
    boundary.failRuns = true;
    await expect(
      h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER }),
    ).rejects.toMatchObject({ code: 'session_start_failed' });
    expect(h.runner.started).toEqual([]);
  });

  it('gives no egress credentials outside the managed VM', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Work' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    expect(h.runner.lastStarted().egressToken).toBeUndefined();
  });
});
