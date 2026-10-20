import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SUPER_DIAGNOSTIC_COLUMNS, SuperDiagnosticsRequest } from '@projectman/shared';
import type { AdministrationCommand, EngineId, Release, SuperActor, SuperCommand } from '@projectman/shared';
import { createDomainHarness, OWNER } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { bindSuperPrincipal } from '../src/core/members';
import type { ProjectAccess } from '../src/core/members';
import type { AdministrationJob, AdministrationPort, AdministrationSubmit } from '../src/contracts';
import { notFound } from '../src/kernel';
import { createAdministrationExecutor, createSuperRights } from '../src/services/super-operator';
import type { SuperAdministrationDeps, SuperCommandExecutor } from '../src/services/super-operator';

const SECRET = 'pmi_admin_fixture';
const KEY = { id: 'ikey_admin_1', prefix: 'pmi_admin_1' };
const CARD_COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const LOCAL = 'local' as EngineId;
const UNLINKED = 'eng_abcdefghijkl' as EngineId;
const NOW = '2026-10-17T10:00:00.000Z';

interface Submitted {
  port: string;
  input: AdministrationSubmit;
}

/** A fake supervisor: records what it is given and keeps the jobs a test can finish. */
function fakePort(name: string, submitted: Submitted[]) {
  const jobs = new Map<string, AdministrationJob>();
  const port: AdministrationPort = {
    status: async (target) => ({
      target,
      online: true,
      version: 'v-test',
      bootId: 'boot-1',
      capabilities: ['status', 'logs', 'restart', 'full_test', 'image_build', 'deploy'],
      activeOperationId: null,
    }),
    logs: async (_target, { limit }) => ({
      entries: Array.from({ length: Math.min(limit, 3) }, (_, index) => ({
        at: NOW,
        level: 'info' as const,
        code: 'fixture',
        message: `entry ${index}`,
      })),
    }),
    submit: async (input) => {
      submitted.push({ port: name, input });
      jobs.set(input.operationId, {
        operationId: input.operationId,
        state: 'running',
        result: null,
        errorCode: null,
        updatedAt: NOW,
      });
      return { accepted: true };
    },
    inspect: async (operationId) => {
      const job = jobs.get(operationId);
      if (!job) throw notFound('administration operation', operationId);
      return job;
    },
  };
  return { port, jobs };
}

const fullTest = (commit = CARD_COMMIT, taskKey = 'AR-1'): SuperCommand => ({
  kind: 'administration',
  request: { kind: 'full_test', taskKey, commit, profile: 'merge-test' },
});
const imageBuild = (commit = CARD_COMMIT): SuperCommand => ({
  kind: 'administration',
  request: { kind: 'image_build', taskKey: 'AR-1', commit, platforms: ['linux/amd64'] },
});
const admin = (request: AdministrationCommand): SuperCommand => ({ kind: 'administration', request });

describe('super mode: diagnostics, test, build and release preparation (PM-764)', () => {
  let h: DomainHarness;
  let submitted: Submitted[];
  let hub: ReturnType<typeof fakePort>;
  let builder: ReturnType<typeof fakePort>;
  let other: ReturnType<typeof fakePort>;
  const created = new Set<string>();
  afterEach(() => h?.cleanup());

  let clock = NOW;
  const boot = async (withAdministration = true) => {
    clock = NOW;
    created.clear();
    submitted = [];
    hub = fakePort('hub', submitted);
    builder = fakePort('builder', submitted);
    other = fakePort('other', submitted);
    h = await createDomainHarness({
      now: () => new Date(clock),
      ...(withAdministration
        ? {
            administration: {
              hub: hub.port,
              engines: {
                port: (id: EngineId) => (id === LOCAL ? builder.port : other.port),
                ids: () => [LOCAL, UNLINKED],
              },
              isEngineOnline: () => true,
              builderEngine: () => LOCAL,
            },
          }
        : {}),
    });
    await h.domain.tasks.create('AR', { title: 'Fictional card' }, { kind: 'human', handle: 'owner' });
    const task = h.repos.tasks.get('AR-1')!;
    h.repos.reviewPins.save({
      projectKey: 'AR',
      taskKey: 'AR-1',
      stageId: task.stageId,
      commit: CARD_COMMIT,
      branch: 'pm/AR-1',
      pinnedAt: NOW,
      pinnedBy: 'dev-1',
    });
  };

  const ensureKey = () => {
    let user = h.repos.users.list()[0];
    if (!user) {
      user = {
        id: 'user-1',
        name: OWNER.name,
        email: OWNER.email,
        passwordHash: 'unused-test-hash',
        createdAt: NOW,
      };
      h.repos.users.insert(user);
    }
    if (!created.has(KEY.id)) {
      created.add(KEY.id);
      // The owner's grant for machine operations (PM-881); the gate itself is tested in operator-grant.test.ts.
      h.auth.grantOperator(user.id, 'until_revoked');
      h.repos.integratorKeys.create({
        id: KEY.id,
        userId: user.id,
        prefix: KEY.prefix,
        hash: createHash('sha256').update(SECRET).digest('hex'),
        mode: 'super',
        at: NOW,
        expiresAt: null,
      });
    }
  };

  const asIntegrator = async <T>(body: (access: ProjectAccess) => Promise<T>): Promise<T> => {
    ensureKey();
    const principal = h.auth.resolveIntegratorCredential(SECRET, 'rest')!;
    const config = await h.domain.projects.config('AR');
    const access = bindSuperPrincipal(
      config,
      { projectKey: 'AR', handle: 'owner', access: 'owner', member: {} } as ProjectAccess,
      principal,
    );
    return h.domain.superOperator.run(
      { principal, email: OWNER.email, requestId: randomUUID(), projectKey: 'AR' },
      () => body(access),
    );
  };

  const operate = (command: SuperCommand, requestId = randomUUID(), taskKey: string | undefined = 'AR-1') =>
    asIntegrator((access) =>
      h.domain.superAdministration.operate(
        'AR',
        { requestId, ...(taskKey ? { taskKey } : {}), command },
        access,
      ),
    );
  const detail = (operationId: string) => h.domain.superAdministration.operation('AR', operationId);
  const timeline = (type: string) => h.repos.timeline.list('AR').filter((event) => event.type === type);

  /** The executor of the composition, with the release the test makes up and a hook just before it starts. */
  const useExecutor = (
    release: (id: string) => Release,
    beforeStart: () => void = () => undefined,
  ): SuperCommandExecutor => {
    const deps: SuperAdministrationDeps = {
      ctx: { repos: h.repos } as unknown as SuperAdministrationDeps['ctx'],
      grants: h.auth.operatorGrantGate,
      administration: h.domain.administration!,
      rights: createSuperRights({
        credentials: h.auth,
        config: (key) => h.domain.projects.config(key),
        projectKeys: () => h.domain.projects.summaries().map((project) => project.key),
      }),
      projects: h.domain.projects,
      timeline: h.domain.timeline,
      engineLinked: (_key, id) => id === LOCAL,
      builderEngine: () => LOCAL,
      release,
    };
    const real = createAdministrationExecutor(deps);
    const wrapped: SuperCommandExecutor = async (job) => {
      beforeStart();
      return real(job);
    };
    h.domain.superHandoffs.registerExecutor('administration', wrapped);
    return wrapped;
  };

  describe('the full test', () => {
    it('runs pinned to the card commit on the builder only and settles onto the card without output', async () => {
      await boot();
      const operation = await operate(fullTest());
      expect(operation).toMatchObject({ state: 'running', taskKey: 'AR-1' });
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toMatchObject({
        port: 'builder',
        input: {
          operationId: operation.id,
          command: { kind: 'full_test', taskKey: 'AR-1', commit: CARD_COMMIT, profile: 'merge-test' },
        },
      });
      // Still running at the supervisor: the operation stays running, nothing is written to the card.
      expect((await detail(operation.id)).operation.state).toBe('running');
      expect(timeline('task_full_test')).toHaveLength(0);

      builder.jobs.set(operation.id, {
        operationId: operation.id,
        state: 'succeeded',
        result: { kind: 'full_test', outcome: 'passed', exitCode: 0, durationMs: 42, failedFiles: [] },
        errorCode: null,
        updatedAt: NOW,
      });
      const done = await detail(operation.id);
      expect(done.operation).toMatchObject({ state: 'succeeded', errorCode: null });
      expect(done.result).toMatchObject({ kind: 'full_test', outcome: 'passed' });
      const events = timeline('task_full_test');
      expect(events).toHaveLength(1);
      expect(events[0]!.taskKey).toBe('AR-1');
      expect(events[0]!.data).toMatchObject({ outcome: 'passed', runId: operation.id, commit: CARD_COMMIT });
      expect(Object.keys(events[0]!.data as object)).not.toContain('outputTail');
      const changed = timeline('super_operation_changed').map((event) => event.data);
      expect(changed.at(-1)).toMatchObject({ operationId: operation.id, state: 'succeeded' });
      // The hub itself ran nothing, and no approval label was written.
      expect(submitted.every((entry) => entry.port === 'builder')).toBe(true);
      expect(h.repos.tasks.get('AR-1')!.labels).not.toContain('qa-ok');
      expect(h.repos.tasks.get('AR-1')!.labels).not.toContain('code-review-ok');
    });

    it('records a failed run as failed with the result kind only, and keeps the failed files on the card', async () => {
      await boot();
      const operation = await operate(fullTest());
      builder.jobs.set(operation.id, {
        operationId: operation.id,
        state: 'succeeded',
        result: {
          kind: 'full_test',
          outcome: 'failed',
          exitCode: 1,
          durationMs: 7,
          failedFiles: ['a.test.ts'],
        },
        errorCode: null,
        updatedAt: NOW,
      });
      const done = await detail(operation.id);
      expect(done.operation).toMatchObject({ state: 'failed', errorCode: 'full_test_failed' });
      expect(timeline('task_full_test')[0]!.data).toMatchObject({
        outcome: 'failed',
        failedFiles: ['a.test.ts'],
      });
      const changed = timeline('super_operation_changed').at(-1)!;
      expect(changed.data).toMatchObject({ state: 'failed', resultKind: expect.any(String) });
      expect(JSON.stringify(changed.data)).not.toContain('a.test.ts');
    });

    it('refuses a commit that is not one of the card’s, an unknown card and a card of another project', async () => {
      await boot();
      const wrongCommit = await operate(fullTest(OTHER_COMMIT));
      expect(wrongCommit).toMatchObject({ state: 'failed', errorCode: 'invalid_request' });
      const wrongCard = await operate(fullTest(CARD_COMMIT, 'AR-9'), randomUUID(), 'AR-1');
      expect(wrongCard).toMatchObject({ state: 'failed', errorCode: 'invalid_request' });
      await expect(operate(fullTest(CARD_COMMIT, 'AR-9'), randomUUID(), 'AR-9')).rejects.toMatchObject({
        status: 404,
      });
      await h.domain.projects.create(
        { key: 'ZZ', name: 'other', workspacePath: h.workspace, templateId: 'test' },
        { name: 'Other', email: 'other@example.com' },
      );
      await h.domain.tasks.create('ZZ', { title: 'Another project' }, { kind: 'human', handle: 'owner' });
      await expect(operate(fullTest(CARD_COMMIT, 'ZZ-1'), randomUUID(), 'ZZ-1')).rejects.toMatchObject({
        status: 404,
      });
      expect(submitted).toEqual([]);
    });

    it('is the same operation for the same request id and a conflict for another command', async () => {
      await boot();
      const requestId = randomUUID();
      const first = await operate(fullTest(), requestId);
      const again = await operate(fullTest(), requestId);
      expect(again.id).toBe(first.id);
      expect(submitted).toHaveLength(1);
      await expect(operate(imageBuild(), requestId)).rejects.toMatchObject({
        code: 'super_request_conflict',
        status: 409,
      });
      expect(submitted).toHaveLength(1);
    });

    it('starts nothing when the key was revoked after the request was authorized', async () => {
      await boot();
      useExecutor(
        () => {
          throw new Error('no release here');
        },
        () => h.repos.integratorKeys.revokeById('user-1', KEY.id, NOW),
      );
      const operation = await operate(fullTest());
      expect(operation).toMatchObject({ state: 'failed', errorCode: 'integrator_key_invalid' });
      expect(submitted).toEqual([]);
    });

    it('becomes unknown, and is never submitted again, when the supervisor lost the record', async () => {
      await boot();
      const operation = await operate(fullTest());
      builder.jobs.delete(operation.id);
      const lost = await detail(operation.id);
      expect(lost.operation).toMatchObject({ state: 'unknown', errorCode: 'operation_unknown' });
      expect(await h.domain.superHandoffs.settleOpen()).toBe(0);
      expect(submitted).toHaveLength(1);
      expect(lost.result).toBeNull();
    });

    it('lets a settle sweep finish a finished job, once, and leaves what is still running', async () => {
      await boot();
      const running = await operate(fullTest());
      const finished = await operate(imageBuild());
      builder.jobs.set(finished.id, {
        operationId: finished.id,
        state: 'succeeded',
        result: {
          kind: 'image_build',
          artifacts: [
            {
              artifactId: 'img_1',
              platform: 'linux/amd64',
              commit: CARD_COMMIT,
              imageDigest: `sha256:${'1'.repeat(64)}`,
              archiveSha256: '2'.repeat(64),
              bytes: 1024,
            },
          ],
        },
        errorCode: null,
        updatedAt: NOW,
      });
      // The first operation holds the supervisor; the second was accepted on the fake only for this check.
      expect(await h.domain.superHandoffs.settleOpen()).toBe(1);
      expect(h.domain.superHandoffs.operation('AR', running.id).state).toBe('running');
      expect(h.domain.superHandoffs.operation('AR', finished.id).state).toBe('succeeded');
      expect(await h.domain.superHandoffs.settleOpen()).toBe(0);
    });
  });

  describe('the image build', () => {
    it('answers with the digest and the checksum and runs on the builder only', async () => {
      await boot();
      const operation = await operate(imageBuild());
      expect(submitted).toMatchObject([{ port: 'builder', input: { command: { kind: 'image_build' } } }]);
      builder.jobs.set(operation.id, {
        operationId: operation.id,
        state: 'succeeded',
        result: {
          kind: 'image_build',
          artifacts: [
            {
              artifactId: 'img_1',
              platform: 'linux/amd64',
              commit: CARD_COMMIT,
              imageDigest: `sha256:${'1'.repeat(64)}`,
              archiveSha256: '2'.repeat(64),
              bytes: 1024,
            },
          ],
        },
        errorCode: null,
        updatedAt: NOW,
      });
      const done = await detail(operation.id);
      expect(done.operation.state).toBe('succeeded');
      expect(done.result).toMatchObject({
        kind: 'image_build',
        artifacts: [{ imageDigest: `sha256:${'1'.repeat(64)}`, archiveSha256: '2'.repeat(64) }],
      });
      // A build writes nothing on the card: only the operation's own record.
      expect(timeline('task_full_test')).toHaveLength(0);
    });

    it('refuses a commit that is not the card’s', async () => {
      await boot();
      expect(await operate(imageBuild(OTHER_COMMIT))).toMatchObject({
        state: 'failed',
        errorCode: 'invalid_request',
      });
      expect(submitted).toEqual([]);
    });
  });

  describe('restart', () => {
    it('restarts the hub only with the owner right in every project', async () => {
      await boot();
      const restart = admin({ kind: 'restart', target: { kind: 'hub' }, expectedBootId: 'boot-1' });
      const operation = await operate(restart, randomUUID(), undefined);
      expect(operation.state).toBe('running');
      expect(submitted).toMatchObject([{ port: 'hub', input: { command: { kind: 'restart' } } }]);

      await h.domain.projects.create(
        { key: 'ZZ', name: 'other', workspacePath: h.workspace, templateId: 'test' },
        { name: 'Other', email: 'other@example.com' },
      );
      submitted.length = 0;
      const refused = await operate(
        admin({ kind: 'restart', target: { kind: 'hub' }, expectedBootId: 'boot-2' }),
        randomUUID(),
        undefined,
      );
      expect(refused).toMatchObject({ state: 'failed', errorCode: 'insufficient_access' });
      expect(submitted).toEqual([]);
    });

    it('refuses an engine that is not linked to the project', async () => {
      await boot();
      const refused = await operate(
        admin({ kind: 'restart', target: { kind: 'engine', id: UNLINKED }, expectedBootId: 'boot-1' }),
        randomUUID(),
        undefined,
      );
      expect(refused).toMatchObject({ state: 'failed', errorCode: 'administration_target_mismatch' });
      const linked = await operate(
        admin({ kind: 'restart', target: { kind: 'engine', id: LOCAL }, expectedBootId: 'boot-1' }),
        randomUUID(),
        undefined,
      );
      expect(linked.state).toBe('running');
      expect(submitted).toMatchObject([{ port: 'builder' }]);
    });
  });

  describe('deploy', () => {
    const release = (over: Partial<Release> = {}) =>
      ({ id: 'rel_1', projectKey: 'AR', state: 'approved', decidedBy: 'owner', ...over }) as Release;
    const deploy = admin({ kind: 'deploy', releaseId: 'rel_1' });

    it('deploys the release a human owner approved without asking the owner again (PM-870)', async () => {
      await boot();
      useExecutor(() => release());
      const started = await operate(deploy, randomUUID(), undefined);
      expect(started.state).toBe('running');
      expect(submitted).toMatchObject([
        { port: 'hub', input: { operationId: started.id, command: { kind: 'deploy', releaseId: 'rel_1' } } },
      ]);
    });

    it.each([
      [
        'a release nobody approved',
        { state: 'proposed' as const, decidedBy: null },
        'release_state_conflict',
      ],
      ['a release an AI member decided', { decidedBy: 'dev-1' }, 'release_state_conflict'],
      ['the release of another project', { projectKey: 'ZZ' }, 'release_target_mismatch'],
    ])('refuses %s', async (_name, over, code) => {
      await boot();
      useExecutor(() => release(over as Partial<Release>));
      const refused = await operate(deploy, randomUUID(), undefined);
      expect(refused).toMatchObject({ state: 'failed', errorCode: code });
      expect(submitted).toEqual([]);
    });
  });

  describe('reads', () => {
    it('answers the status and the log of the hub and of a linked engine, only from the project’s side', async () => {
      await boot();
      ensureKey();
      const facade = h.domain.superAdministration;
      expect(await facade.status('AR', { kind: 'hub' })).toMatchObject({ online: true, bootId: 'boot-1' });
      expect(await facade.status('AR', { kind: 'engine', id: LOCAL })).toMatchObject({ online: true });
      expect((await facade.logs('AR', { kind: 'hub' }, 2)).entries).toHaveLength(2);
      await expect(facade.status('AR', { kind: 'engine', id: UNLINKED })).rejects.toMatchObject({
        code: 'administration_target_mismatch',
        status: 403,
      });
      await expect(facade.logs('AR', { kind: 'engine', id: UNLINKED }, 5)).rejects.toMatchObject({
        code: 'administration_target_mismatch',
      });
    });

    it('is administration_unavailable (503) where the instance has no adapter', async () => {
      await boot(false);
      const facade = h.domain.superAdministration;
      await expect(facade.status('AR', { kind: 'hub' })).rejects.toMatchObject({
        code: 'administration_unavailable',
        status: 503,
      });
      await expect(facade.logs('AR', { kind: 'hub' }, 5)).rejects.toMatchObject({
        code: 'administration_unavailable',
      });
    });

    it('has no executor for a super merge: merging stays with merge_task and its gates', async () => {
      await boot();
      await expect(
        operate({ kind: 'merge', taskKey: 'AR-1', request: {} } as SuperCommand),
      ).rejects.toMatchObject({ code: 'super_executor_unavailable', status: 503 });
      expect(h.domain.superHandoffs.list('AR', { limit: 10 })).toEqual([]);
      expect(h.repos.superHandoffs.listOperations('AR', { limit: 10 })).toEqual([]);
    });
  });

  describe('the filtered diagnostics', () => {
    const query = (body: Record<string, unknown>) =>
      h.domain.superAdministration.query('AR', SuperDiagnosticsRequest.parse(body));

    it('shows only the catalogue’s columns, in order, whatever the query', async () => {
      await boot();
      await operate(fullTest());
      for (const name of ['tasks', 'sessions', 'merges', 'operations'] as const) {
        const answer = query({ query: name });
        expect(answer.columns).toEqual([...SUPER_DIAGNOSTIC_COLUMNS[name]]);
        for (const row of answer.rows) expect(row).toHaveLength(answer.columns.length);
      }
      const tasks = query({ query: 'tasks' });
      expect(tasks.rows).toHaveLength(1);
      expect(tasks.rows[0]![0]).toBe('AR-1');
      const operations = query({ query: 'operations', taskKey: 'AR-1' });
      expect(operations.rows[0]).toEqual([
        expect.stringMatching(/^sop_/),
        'AR-1',
        'running',
        'administration:full_test',
        NOW,
        NOW,
      ]);
      expect(JSON.stringify(operations)).not.toMatch(/email|secret|token|hash/i);
    });

    it('cuts at the limit and says so', async () => {
      await boot();
      await operate(fullTest());
      await operate(imageBuild());
      expect(query({ query: 'operations', limit: 1 })).toMatchObject({ truncated: true });
      expect(query({ query: 'operations', limit: 1 }).rows).toHaveLength(1);
      expect(query({ query: 'operations', limit: 2 })).toMatchObject({ truncated: false });
    });

    it('refuses a query outside the catalogue and a card of another project', async () => {
      await boot();
      expect(() => query({ query: 'users' })).toThrow();
      expect(() => query({ query: 'tasks', sql: 'select 1' })).toThrow();
      expect(() => query({ query: 'tasks', taskKey: 'ZZ-1' })).toThrow(
        expect.objectContaining({ status: 404 }),
      );
    });
  });

  describe('the owner’s grant for machine operations (PM-881)', () => {
    const restartHub = admin({ kind: 'restart', target: { kind: 'hub' }, expectedBootId: 'boot-1' });
    const pause: SuperCommand = { kind: 'operate', operation: { op: 'project_pause' } };
    const grantRow = () => h.repos.operatorGrants.active('user-1', clock);

    it('refuses a machine operation, a status read and a log read without a grant, but not a plain operation', async () => {
      await boot();
      ensureKey();
      h.auth.revokeOperatorGrant('user-1');
      expect(await operate(fullTest())).toMatchObject({
        state: 'failed',
        errorCode: 'operator_grant_inactive',
      });
      expect(await operate(restartHub, randomUUID(), undefined)).toMatchObject({
        state: 'failed',
        errorCode: 'operator_grant_inactive',
      });
      expect(submitted).toEqual([]);
      const facade = h.domain.superAdministration;
      await expect(facade.status('AR', { kind: 'hub' })).rejects.toMatchObject({
        code: 'operator_grant_inactive',
        status: 403,
      });
      await expect(facade.logs('AR', { kind: 'hub' }, 5)).rejects.toMatchObject({
        code: 'operator_grant_inactive',
      });
      expect(await operate(pause, randomUUID(), undefined)).toMatchObject({ state: 'succeeded' });
    });

    it('runs the same operations with an active grant and records its use', async () => {
      await boot();
      ensureKey();
      expect(grantRow()!.lastUsedAt).toBeNull();
      clock = '2026-10-17T10:05:00.000Z';
      expect(await operate(fullTest())).toMatchObject({ state: 'running' });
      expect(grantRow()!.lastUsedAt).toBe(clock);
      clock = '2026-10-17T10:06:00.000Z';
      await h.domain.superAdministration.status('AR', { kind: 'hub' });
      expect(grantRow()!.lastUsedAt).toBe(clock);
    });

    it('lets an operation that was already handed in finish and stay readable, and refuses the next one', async () => {
      await boot();
      const running = await operate(fullTest());
      expect(running.state).toBe('running');
      h.auth.revokeOperatorGrant('user-1');
      builder.jobs.set(running.id, {
        operationId: running.id,
        state: 'succeeded',
        result: { kind: 'full_test', outcome: 'passed', exitCode: 0, durationMs: 1, failedFiles: [] },
        errorCode: null,
        updatedAt: NOW,
      });
      const done = await detail(running.id);
      expect(done.operation.state).toBe('succeeded');
      expect(done.result).toMatchObject({ kind: 'full_test', outcome: 'passed' });
      expect(await operate(fullTest(), randomUUID())).toMatchObject({
        state: 'failed',
        errorCode: 'operator_grant_inactive',
      });
      expect(submitted).toHaveLength(1);
    });

    it('treats an expired grant like a revoked one', async () => {
      await boot();
      ensureKey();
      h.auth.grantOperator('user-1', '12h');
      expect(await operate(fullTest())).toMatchObject({ state: 'running' });
      clock = '2026-10-17T22:00:01.000Z';
      expect(await operate(fullTest(), randomUUID())).toMatchObject({
        state: 'failed',
        errorCode: 'operator_grant_inactive',
      });
      expect(submitted).toHaveLength(1);
    });
  });

  it('counts a super actor as the author of the operation, never as an approver', async () => {
    await boot();
    const operation = await operate(fullTest());
    const actor = h.domain.superHandoffs.operation('AR', operation.id);
    expect(actor.state).toBe('running');
    const event = timeline('super_operation_changed')[0]!;
    expect((event.actor as SuperActor).kind).toBe('ai');
    expect((event.actor as SuperActor).operatorMode).toBe('super');
  });
});
