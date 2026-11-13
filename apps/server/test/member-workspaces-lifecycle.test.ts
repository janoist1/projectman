import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aiActor } from '../src/kernel';
import type { DomainHarness } from './helpers/domain-harness';
import {
  commitFile,
  createWorkspaceHarness,
  exists,
  git,
  useWorkspaceSeed,
  workspaceSteps,
} from './helpers/member-workspaces';
import type { WorkspaceHarnessOptions } from './helpers/member-workspaces';

/* PM-138: a workspace made again and a workspace after its task (the setup is in `helpers/member-workspaces`). */

describe('member workspaces: lifecycle (PM-138)', { timeout: 60_000 }, () => {
  const seed = useWorkspaceSeed();
  let h: DomainHarness;

  async function setup(opts: WorkspaceHarnessOptions = {}) {
    h = await createWorkspaceHarness(seed(), opts);
  }
  afterEach(async () => {
    await h.cleanup();
  });

  const { workspaceOf, startTask, ensure, branchOf, startedCount } = workspaceSteps(() => h);

  it('starts a new conversation when the workspace had to be made again', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    await commitFile(await workspaceOf('dev-1'), 'login.txt', 'v1\n');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await startedCount(2);
    const review = h.runner.lastStarted();
    expect(review.member).toBe('cr');
    h.runner.emit({
      type: 'transcript_path',
      sessionId: review.sessionId,
      path: '/tmp/fictional-review.jsonl',
    });
    await h.domain.sessions.stop('AR', review.sessionId);
    await rm(path.dirname(await workspaceOf('cr')), { recursive: true, force: true });
    const again = await ensure('cr', 'AR-1');
    expect(again.resumed).toBe(false);
    expect(h.runner.lastStarted()).toMatchObject({
      resume: false,
      initialMessage: 'Brief for AR-1: Login page',
    });
    expect(h.runner.lastStarted().claudeSessionId).not.toBe(review.claudeSessionId);
  });

  it('keeps the workspace, its branches, dependencies and the member memory after the task is done', async () => {
    await setup();
    await h.memory.append('AR', 'dev-1', 'The build needs node 22.');
    await startTask('AR-1', 'dev-1');
    const dev1 = await workspaceOf('dev-1');
    const work = await commitFile(dev1, 'login.txt', 'done\n');
    await mkdir(path.join(dev1, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(path.join(dev1, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    h.repos.tasks.update(h.domain.tasks.get('AR', 'AR-1').id, { status: 'done' });
    await h.domain.sessions.cleanupDoneTask('AR', 'AR-1');
    expect(h.runner.isRunning(h.runner.lastStarted().sessionId)).toBe(false);
    expect(h.worktrees.removed).toEqual([]);
    expect(await git(dev1, 'rev-parse', 'AR-1-login-page')).toBe(work);
    expect(await exists(path.join(dev1, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    expect(await h.domain.sessions.memory('AR', 'dev-1')).toContain('The build needs node 22.');

    // The next task starts in the same workspace, with its dependencies, on a fresh branch.
    await startTask('AR-2', 'dev-1');
    expect(h.runner.lastStarted().cwd).toBe(dev1);
    expect(await branchOf(dev1)).toBe('AR-2-signup-page');
    expect(await exists(path.join(dev1, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
  });

  it('finds the task branch elsewhere when the workspace was made again, and reports it missing otherwise', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const first = h.runner.lastStarted();
    const dev1 = await workspaceOf('dev-1');
    const work = await commitFile(dev1, 'login.txt', 'v1\n');
    // The branch also reached the project repository (as a published branch would).
    await git(h.workspace, 'fetch', '--quiet', dev1, 'AR-1-login-page:AR-1-login-page');
    h.runner.emit({ type: 'transcript_path', sessionId: first.sessionId, path: '/tmp/fictional-dev.jsonl' });
    await h.domain.sessions.stop('AR', first.sessionId);
    await rm(path.dirname(dev1), { recursive: true, force: true });
    await ensure('dev-1', 'AR-1');
    expect(h.runner.lastStarted()).toMatchObject({ cwd: dev1, resume: false });
    expect(await git(dev1, 'rev-parse', 'HEAD')).toBe(work);

    // Gone everywhere: not started over from the default branch.
    await h.domain.sessions.stop('AR', h.runner.lastStarted().sessionId);
    await rm(path.dirname(dev1), { recursive: true, force: true });
    await git(h.workspace, 'branch', '--quiet', '-D', 'AR-1-login-page');
    await expect(ensure('dev-1', 'AR-1')).rejects.toMatchObject({ code: 'workspace_branch_missing' });
  });
});
