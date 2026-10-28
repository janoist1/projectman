import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdministrationSubmit } from '../contracts';
import { createBuilderExecutors, FULL_TEST_COMMANDS } from './executors';
import type { BuilderImage, BuilderTestRun, BuilderToolbox } from './executors';
import { ensurePrivateDir } from './secure-fs';
import { createDiagnosticsJournal, createOperationStore } from './store';
import { createSupervisor } from './supervisor';

const CARD_COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const NOW = new Date('2026-10-17T10:00:00.000Z');
const PASSED: BuilderTestRun = { outcome: 'passed', exitCode: 0, durationMs: 12, failedFiles: [] };
const image = (platform: BuilderImage['platform']): BuilderImage => ({
  platform,
  imageDigest: `sha256:${'1'.repeat(64)}`,
  archiveSha256: '2'.repeat(64),
  bytes: 4096,
});

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'adm-exec-'));
  await ensurePrivateDir(stateDir);
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** A builder whose repository holds only the card's commit; every call is recorded. */
function fakeToolbox(overrides: Partial<BuilderToolbox> = {}) {
  const calls = { tests: [] as { commit: string; command: string }[], builds: [] as string[] };
  const toolbox: BuilderToolbox = {
    hasCommit: async (commit) => commit === CARD_COMMIT,
    runTest: async ({ commit, command }) => {
      calls.tests.push({ commit, command });
      return PASSED;
    },
    buildImage: async ({ commit, platform }) => {
      calls.builds.push(`${commit}:${platform}`);
      return image(platform);
    },
    ...overrides,
  };
  return { toolbox, calls };
}

async function build(toolbox: BuilderToolbox) {
  const store = await createOperationStore(stateDir);
  const journal = await createDiagnosticsJournal(stateDir, () => NOW);
  const supervisor = createSupervisor({
    config: { target: { kind: 'engine', id: 'builder' } as never },
    controller: null,
    store,
    journal,
    executors: createBuilderExecutors(toolbox, { newId: () => 'fixed' }),
    now: () => NOW,
    sleep: async () => undefined,
  });
  return { supervisor, store, journal };
}

const fullTest = (
  operationId: string,
  commit = CARD_COMMIT,
  profile: 'merge-test' | 'full-test' = 'merge-test',
) =>
  ({
    operationId,
    requestId: 'req1',
    command: { kind: 'full_test', taskKey: 'PM-1', commit, profile },
  }) satisfies AdministrationSubmit;
const imageBuild = (operationId: string, commit = CARD_COMMIT) =>
  ({
    operationId,
    requestId: 'req1',
    command: { kind: 'image_build', taskKey: 'PM-1', commit, platforms: ['linux/amd64', 'linux/arm64'] },
  }) satisfies AdministrationSubmit;

describe('the builder executors (PM-764)', () => {
  it('tests exactly the pinned commit with the command of the profile and returns only the counts', async () => {
    const { toolbox, calls } = fakeToolbox();
    const { supervisor } = await build(toolbox);
    await supervisor.submit(fullTest('op1', CARD_COMMIT, 'full-test'));
    await supervisor.idle();
    expect(calls.tests).toEqual([{ commit: CARD_COMMIT, command: FULL_TEST_COMMANDS['full-test'] }]);
    expect(FULL_TEST_COMMANDS['full-test']).toBe('npm run merge-test -- --all');
    expect(await supervisor.inspect('op1')).toMatchObject({
      state: 'succeeded',
      result: { kind: 'full_test', outcome: 'passed', exitCode: 0, durationMs: 12, failedFiles: [] },
    });
  });

  it('refuses a commit the builder repository does not hold, without running anything', async () => {
    const { toolbox, calls } = fakeToolbox();
    const { supervisor } = await build(toolbox);
    await supervisor.submit(fullTest('op1', OTHER_COMMIT));
    await supervisor.idle();
    await supervisor.submit(imageBuild('op2', OTHER_COMMIT));
    await supervisor.idle();
    for (const id of ['op1', 'op2'])
      expect(await supervisor.inspect(id)).toMatchObject({ state: 'failed', errorCode: 'invalid_request' });
    expect(calls).toEqual({ tests: [], builds: [] });
  });

  it('keeps a failed or errored test as a result, with the failed files and no output', async () => {
    const { toolbox } = fakeToolbox({
      runTest: async () => ({
        outcome: 'failed',
        exitCode: 1,
        durationMs: 7,
        failedFiles: ['apps/server/test/a.test.ts'],
      }),
    });
    const { supervisor } = await build(toolbox);
    await supervisor.submit(fullTest('op1'));
    await supervisor.idle();
    const job = await supervisor.inspect('op1');
    expect(job).toMatchObject({
      state: 'succeeded',
      result: { outcome: 'failed', failedFiles: ['apps/server/test/a.test.ts'] },
    });
    expect(Object.keys(job.result ?? {}).sort()).toEqual([
      'durationMs',
      'exitCode',
      'failedFiles',
      'kind',
      'outcome',
    ]);
  });

  it('builds every requested platform from the commit and answers digests only', async () => {
    const { toolbox, calls } = fakeToolbox();
    const { supervisor } = await build(toolbox);
    await supervisor.submit(imageBuild('op1'));
    await supervisor.idle();
    expect(calls.builds).toEqual([`${CARD_COMMIT}:linux/amd64`, `${CARD_COMMIT}:linux/arm64`]);
    const job = await supervisor.inspect('op1');
    expect(job.state).toBe('succeeded');
    const result = job.result;
    expect(result?.kind).toBe('image_build');
    if (result?.kind !== 'image_build') return;
    expect(result.artifacts).toHaveLength(2);
    for (const artifact of result.artifacts) {
      expect(artifact).toMatchObject({
        commit: CARD_COMMIT,
        imageDigest: `sha256:${'1'.repeat(64)}`,
        archiveSha256: '2'.repeat(64),
        bytes: 4096,
      });
      // An opaque id, never a path.
      expect(artifact.artifactId).not.toContain('/');
    }
  });

  it('fails a build whose metadata is not a digest and records only the code', async () => {
    const { toolbox } = fakeToolbox({
      buildImage: async ({ platform }) => ({ ...image(platform), imageDigest: '/private/builder/image.tar' }),
    });
    const { supervisor, journal } = await build(toolbox);
    await supervisor.submit(imageBuild('op1'));
    await supervisor.idle();
    const job = await supervisor.inspect('op1');
    expect(job).toMatchObject({ state: 'failed', errorCode: 'administration_failed' });
    expect(JSON.stringify(job)).not.toContain('builder');
    expect(JSON.stringify(await journal.read(50))).not.toContain('builder');
  });

  it('never leaks a build secret: a failure shows a code, the stored files hold no output', async () => {
    const { toolbox } = fakeToolbox({
      runTest: async () => {
        throw new Error('CANARY_BUILD_SECRET=hunter2 in the output');
      },
      buildImage: async () => {
        throw new Error('CANARY_BUILD_SECRET=hunter2 in the output');
      },
    });
    const { supervisor, journal } = await build(toolbox);
    await supervisor.submit(fullTest('op1'));
    await supervisor.idle();
    await supervisor.submit(imageBuild('op2'));
    await supervisor.idle();
    for (const id of ['op1', 'op2'])
      expect(await supervisor.inspect(id)).toMatchObject({
        state: 'failed',
        errorCode: 'administration_failed',
      });
    expect(JSON.stringify(await journal.read(50))).not.toContain('CANARY');
    const files = await readdir(stateDir, { recursive: true, withFileTypes: true });
    for (const file of files.filter((entry) => entry.isFile()))
      expect(await readFile(path.join(file.parentPath, file.name), 'utf8')).not.toContain('CANARY');
  });

  it('waits for the heavy-run queue as a running operation and refuses a second one meanwhile', async () => {
    let release: (run: BuilderTestRun) => void = () => undefined;
    const queued = new Promise<BuilderTestRun>((resolve) => {
      release = resolve;
    });
    const { toolbox, calls } = fakeToolbox({
      runTest: async ({ commit, command }) => {
        calls.tests.push({ commit, command });
        return queued;
      },
    });
    const { supervisor } = await build(toolbox);
    await supervisor.submit(fullTest('op1'));
    expect(await supervisor.inspect('op1')).toMatchObject({
      state: expect.stringMatching(/accepted|running/),
    });
    await expect(supervisor.submit(fullTest('op2'))).rejects.toMatchObject({
      code: 'administration_operation_conflict',
    });
    release(PASSED);
    await supervisor.idle();
    expect(await supervisor.inspect('op1')).toMatchObject({ state: 'succeeded' });
    expect(calls.tests).toHaveLength(1);
  });

  it('marks a run a crash interrupted as unknown after the restart and never runs it again', async () => {
    const first = fakeToolbox({ runTest: () => new Promise<BuilderTestRun>(() => undefined) });
    const crashed = await build(first.toolbox);
    await crashed.supervisor.submit(fullTest('op1'));
    await vi.waitFor(async () => expect((await crashed.supervisor.inspect('op1')).state).toBe('running'));
    // The process dies here: a new supervisor opens the same state directory.
    const second = fakeToolbox();
    const restarted = await build(second.toolbox);
    await restarted.supervisor.recover();
    expect(await restarted.supervisor.inspect('op1')).toMatchObject({ state: 'unknown' });
    // The same id asked again (a lost answer) is the same operation, still not run.
    expect(await restarted.supervisor.submit(fullTest('op1'))).toEqual({ accepted: true });
    await restarted.supervisor.idle();
    expect(second.calls).toEqual({ tests: [], builds: [] });
    expect(await restarted.supervisor.inspect('op1')).toMatchObject({ state: 'unknown' });
  });
});
