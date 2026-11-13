import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AiMemberConfig } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiActor, newId } from '../src/kernel';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import {
  commitFile,
  createWorkspaceHarness,
  exists,
  git,
  scopeCleanup,
  scopeStarts,
  twoTasks,
  useWorkspaceSeed,
  workspaceSteps,
} from './helpers/member-workspaces';
import type { WorkspaceHarnessOptions } from './helpers/member-workspaces';
import { createDomainContext, createEventBus } from '../src/core/base';
import { MemberWorkspaces } from '../src/runtime/sessions/workspaces';
import { createMemberWorkspaceManager } from '../src/worktree';

/* PM-138: review rounds in member workspaces (the setup is in `helpers/member-workspaces`). */

describe('member workspaces: reviews (PM-138)', { timeout: 60_000 }, () => {
  const seed = useWorkspaceSeed();
  let h: DomainHarness;
  let initial: string;

  async function setup(opts: WorkspaceHarnessOptions = {}) {
    h = await createWorkspaceHarness(seed(), opts);
    initial = seed().commit;
  }
  afterEach(async () => {
    await h.cleanup();
  });

  const { workspaceOf, startTask, ensure, branchOf, startedCount } = workspaceSteps(() => h);

  it('selects design review only for a non-implementing designer inspecting another member branch (PM-828)', async () => {
    await setup();
    const config = await h.domain.projects.config('AR');
    const designer: AiMemberConfig = {
      ...(config.team.members.find((m) => m.handle === 'dev-2') as AiMemberConfig),
      role: 'designer',
    };
    const workspaces = new MemberWorkspaces({
      ctx: createDomainContext({
        repos: h.repos,
        bus: createEventBus(),
        logger: h.log.logger,
        now: () => new Date(),
      }),
      manager: createMemberWorkspaceManager({ rootDir: h.workspacesDir, logger: h.log.logger }),
      isRunning: () => false,
      stop: async () => undefined,
      processExists: () => false,
    });
    const unstarted = h.domain.tasks.get('AR', 'AR-1');
    expect(workspaces.kindFor(config, designer, unstarted)).toBe('work');
    await startTask('AR-1', 'dev-1');
    const task = h.domain.tasks.get('AR', 'AR-1');
    expect(workspaces.kindFor(config, designer, task)).toBe('review');
    expect(workspaces.kindFor(config, designer, { ...task, stageId: 'code_review' })).toBe('review');
    expect(workspaces.kindFor(config, designer, { ...task, assignee: designer.handle })).toBe('work');
    config.team.roleOverrides = {
      ...config.team.roleOverrides,
      designer: { duties: ['ux_design', 'implementation'], instructions: '' },
    };
    expect(workspaces.kindFor(config, designer, task)).toBe('work');
  });

  it('gives a Claude session in a review copy a screenshot scope with its session folder (PM-1202)', async () => {
    await setup({
      sessionFolders: true,
      browsersDir: '/engine/browsers',
      adjust: (config) => {
        twoTasks(config);
        config.team.members.push({
          ...(config.team.members.find((m) => m.handle === 'dev-1') as AiMemberConfig),
          kind: 'ai',
          handle: 'designer',
          displayName: 'Designer',
          role: 'designer',
          sponsor: 'owner',
        });
        // The scope exists only for a repository that has a screenshot command (PM-1353).
        const web = config.project.repos.find((repo) => repo.name === 'web');
        if (web) web.screenshots = { command: 'npm run shots --' };
      },
    });
    await startTask('AR-1', 'dev-1');
    const { session } = await ensure('designer', 'AR-1');
    const spec = h.runner.lastStarted();
    expect(spec.policy?.placement.kind).toBe('review_copy');
    const folder = spec.policy!.filesystem.sessionFolder!;
    expect(h.domain.sessions.screenshotScope(session.id)).toMatchObject({
      cwd: spec.cwd,
      sessionDir: folder,
    });
  });

  it.each(['stopped', 'idle', 'working'] as const)(
    'starts a %s designer from the current developer commit on a message in development (PM-828)',
    async (state) => {
      await setup({
        adjust: (config) => {
          twoTasks(config);
          config.team.members.push({
            ...(config.team.members.find((m) => m.handle === 'dev-1') as AiMemberConfig),
            kind: 'ai',
            handle: 'designer',
            displayName: 'Designer',
            role: 'designer',
            sponsor: 'owner',
          });
        },
      });
      // Planning can leave an older branch in the designer's clone.
      await ensure('designer', 'AR-1');
      const planning = h.runner.lastStarted();
      expect(planning.policy?.placement.kind).toBe('task_worktree');
      h.runner.emit({ type: 'transcript_path', sessionId: planning.sessionId, path: '/tmp/planning.jsonl' });
      if (state === 'stopped') await h.domain.sessions.stop('AR', planning.sessionId);
      else h.runner.setState(planning.sessionId, state);
      await startTask('AR-1', 'dev-1');
      const dev = await workspaceOf('dev-1');
      const current = await commitFile(dev, 'screen.txt', 'ready for design review\n');
      const request = async () => {
        await h.domain.messaging.send(
          'AR',
          'dev-1',
          { to: ['designer'], text: 'Please review the screen.', taskKey: 'AR-1' },
          { actor: aiActor('dev-1') },
        );
      };
      await request();
      if (state === 'working') {
        await flush();
        expect(h.runner.started).toHaveLength(2);
        expect(h.runner.stopped).not.toContain(planning.sessionId);
        h.runner.setState(planning.sessionId, 'idle');
      }
      await startedCount(3);
      const designer = await workspaceOf('designer');
      expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('development');
      expect(h.runner.lastStarted().policy?.placement).toMatchObject({
        kind: 'review_copy',
        sourceCommit: current,
        roundId: '1',
      });
      expect(await git(designer, 'rev-parse', 'HEAD')).toBe(current);
      expect(await git(designer, 'rev-parse', 'refs/heads/AR-1-login-page')).toBe(initial);
      expect(
        await h.domain.sessions.sourceHead(
          await h.domain.projects.config('AR'),
          h.domain.tasks.get('AR', 'AR-1'),
        ),
      ).toMatchObject({ commit: current, path: dev });
      expect(await readFile(path.join(designer, 'screen.txt'), 'utf8')).toBe('ready for design review\n');

      // A rewritten developer tip must reach the next round too.
      const review = h.runner.lastStarted();
      h.runner.emit({ type: 'transcript_path', sessionId: review.sessionId, path: '/tmp/designer.jsonl' });
      h.runner.setState(review.sessionId, 'idle');
      await writeFile(path.join(dev, 'screen.txt'), 'revised screen\n');
      await git(dev, 'add', 'screen.txt');
      await git(dev, 'commit', '--quiet', '--amend', '-m', 'Revise screen');
      const rewritten = await git(dev, 'rev-parse', 'HEAD');
      await request();
      await startedCount(4);
      expect(h.runner.lastStarted().policy?.placement).toMatchObject({
        kind: 'review_copy',
        sourceCommit: rewritten,
        roundId: '2',
      });
      expect(await git(designer, 'rev-parse', 'HEAD')).toBe(rewritten);

      await h.domain.sessions.stop('AR', review.sessionId);
      const latest = await commitFile(dev, 'screen.txt', 'latest screen\n');
      await ensure('designer', 'AR-1');
      expect(h.runner.lastStarted().policy?.placement).toMatchObject({
        sourceCommit: latest,
        roundId: '3',
      });
      expect(await git(designer, 'rev-parse', 'HEAD')).toBe(latest);
    },
  );

  it("reviews the handed-over commit in the reviewer's own workspace; a new round on a stage entry or the developer's message", async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const dev1 = await workspaceOf('dev-1');
    const handedOver = await commitFile(dev1, 'login.txt', 'v1\n');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await startedCount(2);
    const review = h.runner.lastStarted();
    const cr = await workspaceOf('cr');
    expect(review).toMatchObject({ member: 'cr', cwd: cr });
    expect(review.policy?.placement).toMatchObject({
      kind: 'review_copy',
      path: cr,
      sourceCommit: handedOver,
      sourceBranch: 'AR-1-login-page',
      baseCommit: initial,
      roundId: '1',
    });
    expect(h.contextBuilder.inputs.at(-1)?.sessionPolicy).toBe(review.policy);
    expect(await git(cr, 'rev-parse', 'HEAD')).toBe(handedOver);
    h.runner.emit({
      type: 'transcript_path',
      sessionId: review.sessionId,
      path: '/tmp/fictional-review.jsonl',
    });
    h.runner.setState(review.sessionId, 'idle');

    // Later and uncommitted work of the developer does not reach the running round.
    const fixed = await commitFile(dev1, 'login.txt', 'v2\n');
    await writeFile(path.join(dev1, 'scratch.txt'), 'scratch\n');
    await h.domain.messaging.send('AR', 'owner', { to: ['cr'], text: 'How is it going?', taskKey: 'AR-1' });
    await flush();
    expect(h.runner.started).toHaveLength(2);
    expect(await git(cr, 'rev-parse', 'HEAD')).toBe(handedOver);

    // The developer asks for a re-review: the idle reviewer restarts on the new commit and
    // continues its conversation with the request.
    await h.domain.messaging.send(
      'AR',
      'dev-1',
      { to: ['cr'], text: 'Fixed, please look again.', taskKey: 'AR-1' },
      { actor: aiActor('dev-1') },
    );
    await startedCount(3);
    expect(h.runner.stopped).toContain(review.sessionId);
    const round2 = h.runner.lastStarted();
    expect(round2).toMatchObject({
      sessionId: review.sessionId,
      resume: true,
      initialMessage: expect.stringContaining('Fixed, please look again.'),
    });
    expect(round2.policy?.placement).toMatchObject({ sourceCommit: fixed, roundId: '2' });
    expect(await git(cr, 'rev-parse', 'HEAD')).toBe(fixed);
    expect(await exists(path.join(cr, 'scratch.txt'))).toBe(false);
    // The reviewer joining the card was told to the developer once; its restart for the new round was not a joining (PM-249).
    const joinedTold = h.runner.messages.filter(
      (m) => m.sessionId === h.runner.started[0]!.sessionId && m.text.includes('Coordinate by send_message'),
    );
    expect(joinedTold.map((m) => m.text)).toEqual([
      expect.stringContaining('`cr` (code reviewer) started working on AR-1 too'),
    ]);

    // Continuing the round (a restart, a person's resume) keeps its commit.
    await commitFile(dev1, 'login.txt', 'v3\n');
    await h.domain.sessions.stop('AR', review.sessionId);
    await ensure('cr', 'AR-1');
    expect(h.runner.lastStarted().policy?.placement).toMatchObject({ sourceCommit: fixed, roundId: '2' });
  });

  it('reads the fetched default branch for a reader on a card with no branch yet, pinned for the round (PM-805)', async () => {
    await setup();
    const head = await commitFile(h.workspace, 'docs.txt', 'current\n');
    await ensure('cr', 'AR-2');
    const first = h.runner.lastStarted();
    const cr = await workspaceOf('cr');
    expect(first).toMatchObject({ member: 'cr', cwd: cr });
    expect(first.policy?.placement).toMatchObject({
      kind: 'review_copy',
      path: cr,
      sourceCommit: head,
      sourceBranch: 'main',
      baseCommit: head,
      roundId: '1',
    });
    expect(await git(cr, 'rev-parse', 'HEAD')).toBe(head);
    expect(await branchOf(cr)).toBe('');

    // Continuing the round keeps its pin even when the default branch moves on.
    await commitFile(h.workspace, 'docs.txt', 'newer\n');
    await h.domain.sessions.stop('AR', first.sessionId);
    await ensure('cr', 'AR-2');
    expect(h.runner.lastStarted().policy?.placement).toMatchObject({ sourceCommit: head, roundId: '1' });
  });

  it('pins a review round to a snapshot in the project repository and imports the approved commit for the merge (PM-739)', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const dev1 = await workspaceOf('dev-1');
    const handedOver = await commitFile(dev1, 'login.txt', 'v1\n');
    const known = (commit: string) =>
      git(h.workspace, 'cat-file', '-e', `${commit}^{commit}`).then(
        () => true,
        () => false,
      );
    expect(await known(handedOver)).toBe(false);

    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await startedCount(2);
    const snapshot = `refs/projectman/workspaces/dev-1/AR-1/${handedOver}`;
    const pin = () => h.repos.memberWorkspaces.bindingsOfTask('AR', 'AR-1').find((b) => b.kind === 'review')!;
    expect(pin()).toMatchObject({
      sourcePath: await realpath(h.workspace),
      sourceRef: snapshot,
      sourceCommit: handedOver,
      round: 1,
    });
    expect(await git(h.workspace, 'rev-parse', snapshot)).toBe(handedOver);
    expect(h.runner.lastStarted().policy?.placement).toMatchObject({ sourceBranch: 'AR-1-login-page' });
    // The developer's branch name is not made in the project repository.
    expect(await git(h.workspace, 'branch', '--list', 'AR-1-login-page')).toBe('');

    // Later work of the developer does not change the pin; the same round continues on it.
    await commitFile(dev1, 'login.txt', 'v2\n');
    const review = h.runner.lastStarted();
    await h.domain.sessions.stop('AR', review.sessionId);
    await ensure('cr', 'AR-1');
    expect(pin()).toMatchObject({ sourceRef: snapshot, sourceCommit: handedOver, round: 1 });

    // The merge reads the approved commit from the project repository: it is imported once.
    const approved = await commitFile(dev1, 'login.txt', 'v3\n');
    expect(await known(approved)).toBe(false);
    const config = await h.domain.projects.config('AR');
    const task = h.domain.tasks.get('AR', 'AR-1');
    await h.domain.sessions.prepareMergeSource(config, task, approved);
    await h.domain.sessions.prepareMergeSource(config, task, approved);
    expect(await known(approved)).toBe(true);
    expect(await git(h.workspace, 'rev-parse', `refs/projectman/workspaces/dev-1/AR-1/${approved}`)).toBe(
      approved,
    );
    // A commit the developer's branch does not hold is refused, never taken from anywhere else.
    await expect(h.domain.sessions.prepareMergeSource(config, task, 'f'.repeat(40))).rejects.toMatchObject({
      code: 'workspace_source_missing',
    });
  });

  it('restarts a hybrid merger in its fix checkout, releases the old scope and ignores clone reservations and review refreshes', async () => {
    const liveProcesses = new Set([1002]);
    await setup({
      liveProcesses,
      adjust(config) {
        twoTasks(config);
        config.project.repos[0]!.requireMerge = true;
        config.team.merger = { kind: 'member', handle: 'cr' };
        config.pipeline.stages = config.pipeline.stages.filter(
          (stage) => stage.id !== 'merge' && stage.id !== 'release',
        );
        config.pipeline.stages.find((stage) => stage.id === 'done')!.gate = {
          conditions: [{ type: 'has_label', label: 'code-review-ok' }],
        };
        const reviewer = config.team.members.find((m) => m.handle === 'cr')!;
        if (reviewer.kind === 'ai') {
          reviewer.role = 'lead_developer';
          reviewer.permissionMode = 'auto';
        }
      },
    });
    vi.spyOn(h.domain.autoAdvance, 'check').mockResolvedValue(undefined);
    scopeStarts(h);
    vi.spyOn(h.runner, 'stop').mockImplementation(async (sessionId) => {
      h.runner.stopped.push(sessionId);
      h.runner.emit({
        type: 'exit',
        sessionId,
        exitCode: 0,
        signal: null,
        cleanup: scopeCleanup('scp_0123456789abcdef', 'clean'),
      });
    });
    await startTask('AR-1', 'dev-1');
    const approved = await commitFile(await workspaceOf('dev-1'), 'login.txt', 'approved\n');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await startedCount(2);
    const review = h.runner.lastStarted();
    const pin = h.repos.memberWorkspaces.bindingsOfTask('AR', 'AR-1').find((b) => b.kind === 'review')!;
    expect(review.member).toBe('cr');
    expect(h.repos.memberWorkspaces.heldBy(review.sessionId)[0]?.holder).toMatchObject({
      pid: 1002,
      scopeId: 'scp_0123456789abcdef',
    });
    h.runner.setState(review.sessionId, 'working');
    const now = new Date().toISOString();
    h.repos.tasks.update(h.domain.tasks.get('AR', 'AR-1').id, { labels: ['code-review-ok'] });
    h.repos.taskMerges.save({
      id: newId('merge'),
      projectKey: 'AR',
      taskKey: 'AR-1',
      repo: 'web',
      base: 'main',
      commit: approved,
      branch: 'AR-1-login-page',
      fromStageId: 'code_review',
      toStageId: 'done',
      merger: 'cr',
      requestedAt: now,
      state: 'fixing',
      landed: 'nowhere',
      createdAt: now,
      updatedAt: now,
      fix: { by: 'cr', base: initial, branch: 'merge-fix/AR-1', startedAt: now },
    });
    h.runner.setState(review.sessionId, 'idle');
    await startedCount(3);
    const fixer = h.runner.lastStarted();
    expect(fixer).toMatchObject({
      sessionId: review.sessionId,
      policy: { placement: { kind: 'task_worktree', mergeFix: { branch: 'merge-fix/AR-1' } } },
    });
    expect(fixer.cwd).toContain('_merge-fix');
    expect(fixer.policy?.filesystem.writableRoots).toContain(fixer.cwd);
    expect(h.repos.memberWorkspaces.heldBy(fixer.sessionId)).toHaveLength(0);
    expect(h.repos.memberWorkspaces.get(pin.workspaceId)?.holder).toBeNull();

    // The merger can review another task in its clone while the fix session uses the worktree.
    await ensure('cr', 'AR-2');
    const other = h.runner.lastStarted();
    h.runner.setState(other.sessionId, 'working');
    const config = await h.domain.projects.config('AR');
    const member = config.team.members.find((m) => m.handle === 'cr') as AiMemberConfig;
    const task = h.domain.tasks.get('AR', 'AR-1');
    expect(() =>
      h.domain.sessions.assertWorkspaceFree(config, member, { ...task, merge: undefined }),
    ).toThrow(expect.objectContaining({ code: 'workspace_busy' }));
    expect(() => h.domain.sessions.assertWorkspaceFree(config, member, task)).not.toThrow();
    await h.domain.sessions.stop('AR', fixer.sessionId);
    await ensure('cr', 'AR-1');
    expect(h.runner.lastStarted()).toMatchObject({ sessionId: fixer.sessionId, cwd: fixer.cwd });
    expect(h.repos.memberWorkspaces.heldBy(fixer.sessionId)).toHaveLength(0);
    expect(h.repos.memberWorkspaces.heldBy(other.sessionId)).toHaveLength(1);

    h.domain.sessions.requestReviewRound('AR', 'AR-1', 'cr');
    const current = h.domain.sessions.get('AR', fixer.sessionId);
    expect(h.domain.sessions.reviewRoundDue({ ...current, cwd: review.cwd })).toBe(true);
    expect(h.domain.sessions.reviewRoundDue(current)).toBe(false);
    const starts = h.runner.started.length;
    h.runner.setState(fixer.sessionId, 'idle');
    await flush();
    expect(h.runner.started).toHaveLength(starts);
    expect(
      h.repos.memberWorkspaces.bindingsOfTask('AR', 'AR-1').find((b) => b.kind === 'review'),
    ).toMatchObject({ ...pin, refresh: true });
  });

  it('still reads a round pinned before PM-739 directly on the developer workspace', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const dev1 = await workspaceOf('dev-1');
    const handedOver = await commitFile(dev1, 'login.txt', 'v1\n');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await startedCount(2);
    const pin = () => h.repos.memberWorkspaces.bindingsOfTask('AR', 'AR-1').find((b) => b.kind === 'review')!;
    // The old shape: the pin names the developer's workspace and branch directly.
    h.repos.memberWorkspaces.saveBinding({
      ...pin(),
      sourcePath: dev1,
      sourceRef: 'refs/heads/AR-1-login-page',
    });
    await h.domain.sessions.stop('AR', h.runner.lastStarted().sessionId);
    await ensure('cr', 'AR-1');
    expect(h.runner.lastStarted().policy?.placement).toMatchObject({
      sourceCommit: handedOver,
      sourceBranch: 'AR-1-login-page',
      roundId: '1',
    });
    expect(pin()).toMatchObject({ sourcePath: dev1, sourceRef: 'refs/heads/AR-1-login-page' });
  });

  it("reviews the assignee's latest commit, not the copy of a developer who opened the task later", async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const dev1 = await workspaceOf('dev-1');
    await commitFile(dev1, 'login.txt', 'v1\n');
    // Another developer is woken on the task: it takes over dev-1's branch as it is now.
    await ensure('dev-2', 'AR-1');
    const dev2 = await workspaceOf('dev-2');
    expect(await branchOf(dev2)).toBe('AR-1-login-page');
    // dev-1, the assignee, goes on; dev-2's copy is now behind (and its binding the newest).
    const latest = await commitFile(dev1, 'login.txt', 'v2\n');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await startedCount(3);
    const review = h.runner.lastStarted();
    expect(review.member).toBe('cr');
    expect(review.policy?.placement).toMatchObject({ sourceCommit: latest });
    expect(await git(await workspaceOf('cr'), 'rev-parse', 'HEAD')).toBe(latest);
  });

  it('holds a re-review request for a reviewer in a turn, then restarts it on the new commit with it', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const dev1 = await workspaceOf('dev-1');
    await commitFile(dev1, 'login.txt', 'v1\n');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await startedCount(2);
    const review = h.runner.lastStarted();
    h.runner.emit({
      type: 'transcript_path',
      sessionId: review.sessionId,
      path: '/tmp/fictional-review.jsonl',
    });
    h.runner.setState(review.sessionId, 'working');
    const fixed = await commitFile(dev1, 'login.txt', 'v2\n');
    await h.domain.messaging.send(
      'AR',
      'dev-1',
      { to: ['cr'], text: 'Fixed, please look again.', taskKey: 'AR-1' },
      { actor: aiActor('dev-1') },
    );
    await flush();
    // Not typed into the turn of the old round, and the turn is not cut short.
    expect(h.runner.messages.filter((m) => m.text.includes('Fixed, please look again.'))).toEqual([]);
    expect(h.runner.stopped).not.toContain(review.sessionId);
    h.runner.setState(review.sessionId, 'idle');
    await startedCount(3);
    expect(h.runner.lastStarted()).toMatchObject({
      sessionId: review.sessionId,
      resume: true,
      initialMessage: expect.stringContaining('Fixed, please look again.'),
    });
    expect(h.runner.lastStarted().policy?.placement).toMatchObject({ sourceCommit: fixed, roundId: '2' });
  });
});
