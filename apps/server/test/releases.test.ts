import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOperator, MemberConfig, releaseApprovalOf, superActorOf } from '@projectman/shared';
import type { InboxItem, ProjectConfig, ReleaseReport } from '@projectman/shared';
import { sendControlRequest } from '../../../scripts/control/client';
import { serveControlConnection } from '../src/control';
import type { ControlRelease } from '../src/control';
import type { BranchMerger, IntegratorExecutionScope, MergeBaseState } from '../src/contracts';
import { conflict, forbidden, runIntegratorExecution } from '../src/kernel';
import type { Resolver } from '../src/core/inbox';
import type { Messaging } from '../src/core/messages';
import type { ProjectService } from '../src/core/projects';
import { ReleaseRoadmapNotices } from '../src/services/releases';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness, OWNER as OWNER_AUTHOR, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { recordingLog, ScriptedPause } from './helpers/control';

/** A commit id as the repository would print it. */
const sha = (n: number) => n.toString(16).padStart(40, '0');

const OWNER = { handle: 'owner', access: 'owner' as const };
const TARGET = { projectKey: 'AR', repo: 'web' };
const devops: ToolContext = { projectKey: 'AR', member: 'devops', sessionId: 'ses_none', taskKey: null };

/** Cards merged one after the other: AR-1 landed as sha(1), AR-2 as sha(2), AR-3 as sha(3). */
const MERGED = [
  { key: 'AR-1', commit: sha(1) },
  { key: 'AR-2', commit: sha(2) },
  { key: 'AR-3', commit: sha(3) },
];

function fakeMerger(head: string) {
  const base: MergeBaseState = {
    local: head,
    remote: null,
    relation: 'same',
    contains: { local: false, remote: null },
    checkout: null,
  };
  return {
    prepare: vi.fn<BranchMerger['prepare']>(async () => structuredClone(base)),
    // The repository is one line of history: a commit is an ancestor of every later one.
    isAncestor: vi.fn<BranchMerger['isAncestor']>(async (_ref, { ancestor, commit }) => ancestor <= commit),
  } as unknown as BranchMerger & {
    prepare: ReturnType<typeof vi.fn>;
    isAncestor: ReturnType<typeof vi.fn>;
  };
}

describe('the release flow', () => {
  let h: DomainHarness;
  let merger: ReturnType<typeof fakeMerger>;

  async function setup(
    opts: {
      appVersion?: string;
      appTag?: () => Promise<string | null>;
      target?: boolean;
      merged?: typeof MERGED;
      head?: string;
      /** The repository's roadmap path (default: set). */
      roadmap?: boolean;
    } = {},
  ) {
    merger = fakeMerger(opts.head ?? sha(3));
    h = await createDomainHarness({
      merger,
      ...(opts.target === false ? {} : { releaseTarget: TARGET }),
      ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
      ...(opts.appTag ? { appTag: opts.appTag } : {}),
      adjust(config: ProjectConfig) {
        if (opts.roadmap !== false) config.project.repos[0]!.docs = { roadmap: 'docs/ROADMAP.md' };
        config.team.members.push(
          MemberConfig.parse({
            kind: 'ai',
            handle: 'devops',
            displayName: 'Devops',
            role: 'devops',
            sponsor: 'owner',
          }),
        );
      },
    });
    for (const [index, { key, commit }] of (opts.merged ?? MERGED).entries()) {
      await h.domain.tasks.create('AR', { title: `Card ${key}`, repo: 'web' }, OWNER_ACTOR);
      h.repos.taskMerges.save({
        id: `mrg_${index + 1}`,
        projectKey: 'AR',
        taskKey: key,
        repo: 'web',
        base: 'main',
        commit: `branch-${key}`,
        branch: `pm/${key}`,
        fromStageId: 'code_review',
        toStageId: 'done',
        merger: 'dev-1',
        requestedAt: '2026-01-01T00:00:00.000Z',
        startedBy: 'dev-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        mergeCommit: commit,
        landed: 'nowhere',
        state: 'merged',
        step: 'finishing',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      });
    }
  }

  const propose = (over: { commit?: string; title?: string } = {}) =>
    h.domain.releases.propose('AR', 'devops', {
      title: over.title ?? 'Release',
      summary: '- AR-1 Card',
      ...(over.commit ? { commit: over.commit } : {}),
    });
  const approvalOf = (): InboxItem => h.domain.inbox.list('AR', { kind: 'release', state: 'open' })[0]!;
  const decide = (optionId: 'approve' | 'reject', by: Resolver = OWNER, item = approvalOf()) =>
    h.domain.inbox.resolve('AR', item.id, { optionId }, by);
  /** A proposed and approved release. */
  async function approved() {
    const { release } = await propose();
    await decide('approve');
    return release;
  }
  /** A release the watcher has claimed and that runs as the commit now. */
  async function deploying() {
    const release = await approved();
    h.domain.releases.claim(release.id, sha(0));
    return { release };
  }
  const events = (taskKey: string) =>
    h.domain.timeline.list('AR', { taskKey }).filter((event) => event.type === 'release_changed');
  const alerts = () => h.domain.inbox.list('AR', { kind: 'alert', state: 'open' });
  const task = (key: string) => h.domain.tasks.get('AR', key);

  afterEach(async () => {
    vi.restoreAllMocks();
    await h?.cleanup();
  });

  describe('what a release contains', () => {
    it('includes every train member sharing a merge commit in candidate and unreleased', async () => {
      await setup({
        appVersion: sha(1),
        merged: [
          { key: 'AR-1', commit: sha(1) },
          { key: 'AR-2', commit: sha(3) },
          { key: 'AR-3', commit: sha(3) },
        ],
      });
      expect((await h.domain.releases.candidate('AR')).tasks.map((task) => task.key)).toEqual([
        'AR-2',
        'AR-3',
      ]);
      expect(h.domain.releases.unreleased('AR')).toMatchObject({ count: 2, taskKeys: ['AR-2', 'AR-3'] });
      h.setAppVersion(sha(3));
      expect(h.domain.releases.unreleased('AR')).toBeNull();
      await expect(h.domain.releases.candidate('AR')).rejects.toMatchObject({ code: 'release_empty' });
    });
    it('is every merged card when nothing is known to run, up to the head of the default branch', async () => {
      await setup();
      const candidate = await h.domain.releases.candidate('AR');
      expect(candidate).toEqual({
        repo: 'web',
        commit: sha(3),
        baseCommit: null,
        tasks: [
          { key: 'AR-1', title: 'Card AR-1' },
          { key: 'AR-2', title: 'Card AR-2' },
          { key: 'AR-3', title: 'Card AR-3' },
        ],
      });
      expect(merger.prepare).toHaveBeenCalledWith(
        { projectKey: 'AR', repo: 'web' },
        { base: expect.any(String), commit: sha(3) },
      );
    });

    it('leaves out the cards the running version already holds', async () => {
      await setup({ appVersion: sha(1) });
      const candidate = await h.domain.releases.candidate('AR');
      expect(candidate.baseCommit).toBe(sha(1));
      expect(candidate.tasks.map((task) => task.key)).toEqual(['AR-2', 'AR-3']);
    });

    it('stops at a chosen merge commit, and refuses a commit no merge produced', async () => {
      await setup();
      expect((await h.domain.releases.candidate('AR', sha(2))).tasks.map((task) => task.key)).toEqual([
        'AR-1',
        'AR-2',
      ]);
      await expect(h.domain.releases.candidate('AR', sha(9))).rejects.toMatchObject({
        code: 'release_commit_unknown',
      });
    });

    it('is empty when no card has landed, or when everything is already running', async () => {
      await setup({ merged: [] });
      await expect(h.domain.releases.candidate('AR')).rejects.toMatchObject({ code: 'release_empty' });
    });

    it('is empty when the running version is the newest merge', async () => {
      await setup({ appVersion: sha(3) });
      await expect(h.domain.releases.candidate('AR')).rejects.toMatchObject({ code: 'release_empty' });
    });

    it('is refused when the instance is not set up to release', async () => {
      await setup({ target: false });
      await expect(h.domain.releases.candidate('AR')).rejects.toMatchObject({
        code: 'release_not_configured',
      });
      await expect(propose()).rejects.toMatchObject({ code: 'release_not_configured' });
      expect(() => h.domain.releases.next()).toThrowError(
        expect.objectContaining({ code: 'release_not_configured' }),
      );
    });

    it('is refused for another project than the target', async () => {
      await setup();
      await expect(h.domain.releases.candidate('OTHER')).rejects.toMatchObject({
        code: 'release_not_configured',
      });
    });
  });

  describe('the check (PM-542)', () => {
    /** The rows a proposal would write: releases, the timeline of every card and the inbox. */
    const written = () => ({
      releases: h.repos.releases.list('AR').length,
      timeline: h.domain.timeline.list('AR', {}).length,
      inbox: h.domain.inbox.list('AR', {}).length,
      tasks: h.domain.tasks.list('AR').length,
    });

    it('gives the candidate and the members with the deployment duty, and records nothing', async () => {
      await setup();
      const before = written();
      const check = await h.domain.releases.check('AR');
      expect(check.refusal).toBeNull();
      expect(check.candidate).toEqual(await h.domain.releases.candidate('AR'));
      expect(check.proposers).toContain('devops');
      expect(written()).toEqual(before);
    });

    it.each([
      ['release_empty', { merged: [] }, undefined],
      ['release_commit_unknown', {}, sha(9)],
      ['release_not_configured', { target: false }, undefined],
    ] as const)(
      'refuses with %s, the code and the message the proposal gives, and records nothing',
      async (code, opts, commit) => {
        await setup(opts as Parameters<typeof setup>[0]);
        const before = written();
        const check = await h.domain.releases.check('AR', commit);
        const refused = await propose(commit ? { commit } : {}).catch((err: unknown) => err);
        expect(check.candidate).toBeNull();
        expect(check.refusal).toEqual({ code, message: (refused as Error).message });
        expect(written()).toEqual(before);
      },
    );

    it('refuses while a release is open, with the proposal’s message', async () => {
      await setup();
      const { release } = await propose();
      const before = written();
      const check = await h.domain.releases.check('AR');
      const refused = await propose({ title: 'Another' }).catch((err: unknown) => err);
      expect(check.refusal).toEqual({ code: 'release_open', message: (refused as Error).message });
      expect(check.refusal?.message).toContain(release.id);
      expect(written()).toEqual(before);
    });

    it('refuses when the engine that holds the repository is offline', async () => {
      await setup();
      vi.spyOn(h.domain.releases as unknown as { merger(p: string): unknown }, 'merger').mockImplementation(
        () => {
          throw conflict('engine_offline', 'the engine that holds the repository is not connected');
        },
      );
      const check = await h.domain.releases.check('AR');
      expect(check.refusal?.code).toBe('engine_offline');
    });

    it('lets a failure that is no refusal of a release through', async () => {
      await setup();
      vi.spyOn(h.domain.projects, 'config').mockRejectedValue(new Error('broken config'));
      await expect(h.domain.releases.check('AR')).rejects.toThrow('broken config');
    });

    it('is open to the Operator only as a tool', async () => {
      await setup();
      const operator: ToolContext = {
        projectKey: 'AR',
        member: 'operator',
        sessionId: 'ses_op',
        taskKey: null,
      };
      await expect(h.domain.teamTools.checkRelease(devops, {})).rejects.toMatchObject({
        code: 'forbidden',
        message: expect.stringContaining('operator_only'),
      });
      const result = await h.domain.teamTools.checkRelease(operator, {});
      expect(result.refusal).toBeNull();
      expect(result.candidate?.commit).toBe(sha(3));
    });
  });

  describe('the overview for the Operator (PM-542)', () => {
    it('has no release block for a project the instance does not release', async () => {
      await setup();
      expect(await h.domain.releases.overview('OTHER')).toBeNull();
      await h.cleanup();
      await setup({ target: false });
      expect(await h.domain.releases.overview('AR')).toBeNull();
    });

    it('names the running build, takes its tag from the build and lists the latest merges newest first', async () => {
      await setup({ appVersion: sha(2) });
      const overview = await h.domain.releases.overview('AR');
      expect(overview).toMatchObject({
        running: { version: sha(2), commit: sha(2), tag: null },
        latestLive: null,
        open: null,
      });
      expect(overview?.recentMerges).toEqual([
        { taskKey: 'AR-3', title: 'Card AR-3', commit: sha(3), at: '2026-01-03T00:00:00.000Z', by: 'dev-1' },
        { taskKey: 'AR-2', title: 'Card AR-2', commit: sha(2), at: '2026-01-02T00:00:00.000Z', by: 'dev-1' },
        { taskKey: 'AR-1', title: 'Card AR-1', commit: sha(1), at: '2026-01-01T00:00:00.000Z', by: 'dev-1' },
      ]);
      await h.cleanup();
      await setup({ appVersion: sha(2), appTag: async () => 'v2026.10.1' });
      expect((await h.domain.releases.overview('AR'))?.running.tag).toBe('v2026.10.1');
      await h.cleanup();
      // A version that is no commit (an override) has no commit.
      await setup({ appVersion: 'dev' });
      expect((await h.domain.releases.overview('AR'))?.running).toEqual({
        version: 'dev',
        commit: null,
        tag: null,
      });
    });

    it('keeps the ten latest merges only', async () => {
      const merged = Array.from({ length: 12 }, (_, index) => ({
        key: `AR-${index + 1}`,
        commit: sha(index + 1),
      }));
      await setup({ merged, head: sha(12) });
      const overview = await h.domain.releases.overview('AR');
      expect(overview?.recentMerges.map((m) => m.taskKey)).toEqual(
        merged
          .slice(2)
          .map((m) => m.key)
          .reverse(),
      );
    });

    it('shows the open release, and the live one with its tag as the running build', async () => {
      await setup();
      const { release } = await propose();
      expect((await h.domain.releases.overview('AR'))?.open).toEqual({
        id: release.id,
        taskKey: release.taskKey,
        state: 'proposed',
        commit: sha(3),
        proposedBy: 'devops',
      });
      await decide('approve');
      h.domain.releases.claim(release.id, sha(0));
      h.setAppVersion(sha(3));
      await h.domain.releases.report(release.id, { outcome: 'live' });
      await h.domain.releases.report(release.id, {
        outcome: 'published',
        tag: 'v2026.10.11',
        url: 'https://example.test/releases/v2026.10.11',
      });
      const overview = await h.domain.releases.overview('AR');
      expect(overview?.open).toBeNull();
      expect(overview?.latestLive).toMatchObject({
        id: release.id,
        taskKey: release.taskKey,
        tag: 'v2026.10.11',
        commit: sha(3),
      });
      expect(overview?.running).toEqual({ version: sha(3), commit: sha(3), tag: 'v2026.10.11' });
    });
  });

  describe('the proposal', () => {
    it('makes the release, its theme card and one approval request for the owners', async () => {
      await setup();
      const { release, candidate } = await propose({ title: 'Release 2026.10.11' });

      expect(release).toMatchObject({
        state: 'proposed',
        commit: sha(3),
        baseCommit: null,
        tasks: ['AR-1', 'AR-2', 'AR-3'],
        proposedBy: 'devops',
        taskKey: 'AR-4',
      });
      expect(candidate.tasks).toHaveLength(3);
      expect(h.domain.releases.get(release.id)).toEqual(release);

      const card = task('AR-4');
      expect(card).toMatchObject({ kind: 'theme', title: 'Release 2026.10.11' });
      expect(card.description).toContain('- AR-2 Card AR-2');
      expect(card.description).toContain(`Commit: ${sha(3)}`);

      const items = h.domain.inbox.list('AR', { kind: 'release', state: 'open' });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ assignees: ['owner'], taskKey: 'AR-4', source: 'devops' });
      expect(items[0]!.options.map((option) => option.id)).toEqual(['approve', 'reject']);
      expect(releaseApprovalOf(items[0]!)).toMatchObject({ releaseId: release.id, commit: sha(3) });
      expect(events('AR-4')).toHaveLength(1);
      expect(events('AR-4')[0]!.data).toMatchObject({ state: 'proposed', previousState: null });
    });

    it('is the deployment duty holder alone who proposes', async () => {
      await setup();
      const rejected = [
        h.domain.releases.propose('AR', 'dev-1', { title: 'x', summary: 'y' }),
        h.domain.releases.propose('AR', 'owner', { title: 'x', summary: 'y' }),
        h.domain.releases.preview('AR', 'dev-1'),
      ];
      for (const attempt of rejected)
        await expect(attempt).rejects.toMatchObject({ code: 'insufficient_access', status: 403 });
      expect(h.repos.releases.list('AR')).toEqual([]);
      expect(h.domain.inbox.list('AR', { kind: 'release' })).toEqual([]);
    });

    it('leaves a card behind for no proposal that is refused', async () => {
      await setup({ merged: [] });
      await expect(propose()).rejects.toMatchObject({ code: 'release_empty' });
      expect(h.domain.tasks.list('AR').filter((card) => card.kind === 'theme')).toEqual([]);
    });

    it('allows one open release at a time, and the next one after it ended', async () => {
      await setup();
      const { release } = await propose();
      await expect(propose()).rejects.toMatchObject({
        code: 'release_open',
        status: 409,
        details: { id: release.id, state: 'proposed' },
      });
      await decide('reject');
      const again = await propose({ title: 'Second try' });
      expect(again.release.id).not.toBe(release.id);
      expect(again.release.taskKey).not.toBe(release.taskKey);
    });

    it('does not let two proposals at once both be recorded', async () => {
      await setup();
      const results = await Promise.allSettled([propose({ title: 'A' }), propose({ title: 'B' })]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(h.repos.releases.list('AR')).toHaveLength(1);
      expect(h.domain.tasks.list('AR').filter((card) => card.kind === 'theme')).toHaveLength(1);
    });

    it('keeps the approval request when the proposer is retired, so the release is not stuck', async () => {
      await setup();
      const { release } = await propose();
      const item = approvalOf();

      await h.domain.members.retire('AR', 'devops', {}, { actor: OWNER_ACTOR, author: OWNER_AUTHOR });

      expect(h.domain.inbox.get('AR', item.id)).toMatchObject({ state: 'open' });
      await decide('approve');
      expect(h.domain.releases.get(release.id)).toMatchObject({ state: 'approved' });
    });

    it('previews with nothing recorded', async () => {
      await setup();
      const candidate = await h.domain.releases.preview('AR', 'devops');
      expect(candidate.tasks).toHaveLength(3);
      expect(h.repos.releases.list('AR')).toEqual([]);
      expect(h.domain.inbox.list('AR', { kind: 'release' })).toEqual([]);
    });
  });

  describe('the owner decides', () => {
    it('approves: the release can be deployed and the item is closed', async () => {
      await setup();
      const { release } = await propose();
      const item = approvalOf();
      const resolved = await decide('approve');
      expect(resolved).toMatchObject({ id: item.id, state: 'resolved' });
      expect(h.domain.releases.get(release.id)).toMatchObject({
        state: 'approved',
        decidedBy: 'owner',
        decidedAt: expect.any(String),
      });
      expect(task('AR-4').status).toBe('active');
      expect(h.domain.releases.next()?.id).toBe(release.id);
      expect(events('AR-4').map((event) => event.data)).toMatchObject([
        { state: 'proposed' },
        { state: 'approved', previousState: 'proposed' },
      ]);
    });

    it('rejects: the release ends and its card is cancelled', async () => {
      await setup();
      const { release } = await propose();
      await decide('reject');
      expect(h.domain.releases.get(release.id)).toMatchObject({ state: 'rejected', decidedBy: 'owner' });
      expect(task('AR-4').status).toBe('cancelled');
      expect(h.domain.releases.next()).toBeNull();
      // The card is closed by the person who decided, and no reason was given.
      const closed = h.domain.timeline
        .list('AR', { taskKey: 'AR-4' })
        .find(
          (event) => event.type === 'task_updated' && (event.data as { action?: string }).action === 'closed',
        );
      expect(closed?.actor).toMatchObject({ kind: 'human', handle: 'owner' });
      expect(events('AR-4').at(-1)!.data).not.toHaveProperty('note');
    });

    it('keeps the reason of a rejection on the release card, and only of a rejection', async () => {
      await setup();
      await propose();
      await h.domain.inbox.resolve(
        'AR',
        approvalOf().id,
        { optionId: 'reject', note: '  Not this week.  ' },
        OWNER,
      );
      expect(events('AR-4').at(-1)!.data).toMatchObject({ state: 'rejected', note: 'Not this week.' });

      await propose({ title: 'Second try' });
      await h.domain.inbox.resolve('AR', approvalOf().id, { optionId: 'approve', note: 'Go ahead' }, OWNER);
      const approvedEvent = h.domain.timeline
        .list('AR', { taskKey: 'AR-5' })
        .filter((event) => event.type === 'release_changed')
        .at(-1)!;
      expect(approvedEvent.data).toMatchObject({ state: 'approved' });
      expect(approvedEvent.data).not.toHaveProperty('note');
    });

    it('is refused for an AI member', async () => {
      await setup();
      await propose();
      await expect(decide('approve', { handle: 'devops', access: 'owner' as const })).rejects.toMatchObject({
        code: 'ai_approval_forbidden',
      });
      expect(h.repos.releases.open('AR')?.state).toBe('proposed');
    });

    it('is refused through an integrator key', async () => {
      await setup();
      await propose();
      await expect(decide('approve', { ...OWNER, via: 'integrator' })).rejects.toMatchObject({
        code: 'owner_approval_required',
      });
      expect(h.repos.releases.open('AR')?.state).toBe('proposed');
    });

    it('is refused for a person who is not an approver', async () => {
      await setup();
      await propose();
      await expect(decide('approve', { handle: 'stranger', access: 'developer' })).rejects.toBeDefined();
      expect(h.repos.releases.open('AR')?.state).toBe('proposed');
    });

    it('cannot be decided twice', async () => {
      await setup();
      await propose();
      const item = approvalOf();
      await decide('approve');
      await expect(decide('reject', OWNER, item)).rejects.toMatchObject({ code: 'inbox_item_closed' });
      expect(h.repos.releases.open('AR')?.state).toBe('approved');
    });
  });

  describe('the watcher drives the release', () => {
    it('claims an approved release once, and records where a rollback goes', async () => {
      await setup();
      const release = await approved();
      const claimed = h.domain.releases.claim(release.id, sha(0));
      expect(claimed).toMatchObject({
        state: 'deploying',
        previousCommit: sha(0),
        deployStartedAt: expect.any(String),
      });
      expect(() => h.domain.releases.claim(release.id, sha(0))).toThrowError(
        expect.objectContaining({ code: 'release_state_conflict' }),
      );
      // A deploying release is still the one the watcher has something to do with.
      expect(h.domain.releases.next()?.state).toBe('deploying');
    });

    it('refuses to claim a release that was never approved', async () => {
      await setup();
      const { release } = await propose();
      expect(() => h.domain.releases.claim(release.id, null)).toThrowError(
        expect.objectContaining({ code: 'release_state_conflict' }),
      );
      expect(() => h.domain.releases.claim('rel_missing', null)).toThrowError(
        expect.objectContaining({ code: 'not_found' }),
      );
    });

    it('is live only when the server runs the release commit', async () => {
      await setup({ appVersion: sha(0) });
      const { release } = await deploying();
      await expect(h.domain.releases.report(release.id, { outcome: 'live' })).rejects.toMatchObject({
        code: 'release_state_conflict',
        details: { appVersion: sha(0), commit: sha(3) },
      });
      expect(h.domain.releases.get(release.id).state).toBe('deploying');
    });

    it('goes live, then published: the tag is kept and the card is closed', async () => {
      await setup();
      const { release } = await deploying();
      h.setAppVersion(sha(3));
      const live = await h.domain.releases.report(release.id, { outcome: 'live' });
      expect(live).toMatchObject({ state: 'live', liveAt: expect.any(String) });
      // Live, but not yet published: the watcher still has the publishing to do.
      expect(h.domain.releases.next()?.id).toBe(release.id);
      expect(task('AR-4').status).toBe('active');

      const published = await h.domain.releases.report(release.id, {
        outcome: 'published',
        tag: 'v2026.10.11',
        url: 'https://example.test/releases/v2026.10.11',
      });
      expect(published).toMatchObject({
        state: 'published',
        tag: 'v2026.10.11',
        publishedAt: expect.any(String),
      });
      // The outcome is in the record and its events; a theme ends as cancelled, so it can be reopened.
      expect(task('AR-4').status).toBe('cancelled');
      expect(h.domain.releases.next()).toBeNull();
      expect(events('AR-4').map((event) => (event.data as { state: string }).state)).toEqual([
        'proposed',
        'approved',
        'deploying',
        'live',
        'published',
      ]);
    });

    it('bases the next release on the one that went live', async () => {
      await setup();
      const { release } = await propose({ commit: sha(2) });
      await decide('approve');
      h.domain.releases.claim(release.id, sha(1));
      h.setAppVersion(sha(2));
      await h.domain.releases.report(release.id, { outcome: 'live' });
      await h.domain.releases.report(release.id, { outcome: 'published', tag: 'v2026.10.11', url: 'u' });
      const next = await h.domain.releases.candidate('AR');
      expect(next.baseCommit).toBe(sha(2));
      expect(next.tasks.map((card) => card.key)).toEqual(['AR-3']);
    });

    it('cancels the card and tells the owners when the deploy failed', async () => {
      await setup();
      const { release } = await deploying();
      const failure = { step: 'switch' as const, message: 'disk full', rolledBack: true };
      const failed = await h.domain.releases.report(release.id, { outcome: 'failed', failure });
      expect(failed).toMatchObject({ state: 'failed', failure });
      expect(task('AR-4').status).toBe('cancelled');
      const [alert] = alerts();
      expect(alert).toMatchObject({ assignees: ['owner'], taskKey: 'AR-4' });
      expect(alert!.payload).toMatchObject({
        alert: 'release_failed',
        releaseId: release.id,
        step: 'switch',
        rolledBack: true,
      });
      // The release is over: another can be proposed.
      expect(h.domain.releases.next()).toBeNull();
      await expect(propose()).resolves.toBeDefined();
    });

    it('tells the owners about a failure to publish once, however often the watcher retries', async () => {
      await setup();
      const { release } = await deploying();
      h.setAppVersion(sha(3));
      await h.domain.releases.report(release.id, { outcome: 'live' });
      await h.domain.releases.report(release.id, { outcome: 'publish_failed', message: 'no network' });
      await h.domain.releases.report(release.id, { outcome: 'publish_failed', message: 'still no network' });
      expect(h.domain.releases.get(release.id)).toMatchObject({
        state: 'live',
        publishError: 'still no network',
      });
      expect(alerts()).toHaveLength(1);
      // A later success clears the error.
      const published = await h.domain.releases.report(release.id, {
        outcome: 'published',
        tag: 'v2026.10.11',
        url: 'u',
      });
      expect(published.publishError).toBeNull();
    });

    it.each<[string, ReleaseReport]>([
      ['live', { outcome: 'live' }],
      ['failed', { outcome: 'failed', failure: { step: 'build', message: 'x', rolledBack: false } }],
      ['published', { outcome: 'published', tag: 'v2026.10.11', url: 'u' }],
      ['publish_failed', { outcome: 'publish_failed', message: 'x' }],
    ])('refuses a %s report out of order', async (_name, report) => {
      await setup();
      // Only proposed: the watcher has not claimed it, so nothing it reports can be true.
      const { release } = await propose();
      h.setAppVersion(sha(3));
      await expect(h.domain.releases.report(release.id, report)).rejects.toMatchObject({
        code: 'release_state_conflict',
      });
      expect(h.domain.releases.get(release.id).state).toBe('proposed');
    });

    it('refuses to publish a release that is not live', async () => {
      await setup();
      const { release } = await deploying();
      await expect(
        h.domain.releases.report(release.id, { outcome: 'published', tag: 'v2026.10.11', url: 'u' }),
      ).rejects.toMatchObject({ code: 'release_state_conflict' });
    });
  });

  describe('on the control socket', () => {
    const servers: net.Server[] = [];
    afterEach(async () => {
      for (const server of servers.splice(0))
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    async function open(release: ControlRelease | undefined) {
      const server = net.createServer((connection) =>
        serveControlConnection(connection, new ScriptedPause(), recordingLog(), release),
      );
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return { host: '127.0.0.1', port: (server.address() as net.AddressInfo).port };
    }
    const adapter = (): ControlRelease => ({
      appVersion: () => h.domain.releases.appVersion(),
      next: () => h.domain.releases.next(),
      get: (id) => h.domain.releases.getForControl(id),
      claim: (id, previous) => h.domain.releases.claim(id, previous),
      report: (id, report) => h.domain.releases.report(id, report),
    });

    it('lets the watcher read, claim and report a release, and tells the version the server runs', async () => {
      await setup({ appVersion: sha(0) });
      const target = await open(adapter());
      const idle = await sendControlRequest(target, { op: 'release_next' });
      expect(idle).toMatchObject({ ok: true, release: null, appVersion: sha(0) });

      const { release } = await propose();
      // Proposed is not approved: the watcher sees nothing yet.
      expect(await sendControlRequest(target, { op: 'release_next' })).toMatchObject({ release: null });
      await decide('approve');
      const next = await sendControlRequest(target, { op: 'release_next' });
      expect(next).toMatchObject({
        ok: true,
        release: { id: release.id, state: 'approved', commit: sha(3) },
      });

      const claimed = await sendControlRequest(target, {
        op: 'release_claim',
        releaseId: release.id,
        previousCommit: sha(0),
      });
      expect(claimed).toMatchObject({ ok: true, release: { state: 'deploying', previousCommit: sha(0) } });
      // The server restarts on the release's commit; the watcher reads that in every answer.
      h.setAppVersion(sha(3));
      const live = await sendControlRequest(target, {
        op: 'release_report',
        releaseId: release.id,
        report: { outcome: 'live' },
      });
      expect(live).toMatchObject({ ok: true, release: { state: 'live' }, appVersion: sha(3) });
    });

    it('passes the domain error code on, and refuses a malformed request', async () => {
      await setup();
      const target = await open(adapter());
      const { release } = await propose();
      expect(
        await sendControlRequest(target, {
          op: 'release_claim',
          releaseId: release.id,
          previousCommit: null,
        }),
      ).toMatchObject({ ok: false, error: { code: 'release_state_conflict' } });
      expect(
        await sendControlRequest(target, {
          op: 'release_claim',
          releaseId: 'rel_missing',
          previousCommit: null,
        }),
      ).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(
        await sendControlRequest(target, {
          op: 'release_report',
          releaseId: release.id,
          report: { outcome: 'published', tag: 'latest', url: 'u' },
        } as never),
      ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    });

    it('reads a release in every state, so a lost claim or report answer can be reconciled (PM-749)', async () => {
      await setup({ appVersion: sha(0) });
      const target = await open(adapter());
      const { release } = await propose();
      const get = () => sendControlRequest(target, { op: 'release_get', releaseId: release.id });
      expect(await get()).toMatchObject({ ok: true, release: { id: release.id, state: 'proposed' } });
      await decide('approve');
      expect(await get()).toMatchObject({ ok: true, release: { state: 'approved' } });
      await sendControlRequest(target, {
        op: 'release_claim',
        releaseId: release.id,
        previousCommit: sha(0),
      });
      // The claim's answer was lost: the state says it was applied, and claiming again changes nothing.
      expect(await get()).toMatchObject({
        ok: true,
        release: { state: 'deploying', previousCommit: sha(0) },
      });
      expect(
        await sendControlRequest(target, {
          op: 'release_claim',
          releaseId: release.id,
          previousCommit: sha(0),
        }),
      ).toMatchObject({ ok: false, error: { code: 'release_state_conflict' } });
      h.setAppVersion(sha(3));
      await sendControlRequest(target, {
        op: 'release_report',
        releaseId: release.id,
        report: { outcome: 'live' },
      });
      expect(await get()).toMatchObject({ ok: true, release: { state: 'live' }, appVersion: sha(3) });
      expect(await sendControlRequest(target, { op: 'release_get', releaseId: 'rel_missing' })).toMatchObject(
        {
          ok: false,
          error: { code: 'not_found' },
        },
      );
    });

    it.each([
      // A project holds one open release, so a foreign copy in the target's own project is a finished one:
      // the target check must come before the state check (claiming a live release would be a state conflict).
      ['another repository', { repo: 'other', state: 'live', liveAt: '2026-01-01T00:00:00.000Z' }],
      ['another project', { projectKey: 'ZZ', state: 'approved' }],
    ] as const)('refuses to read, claim or report a release of %s (PM-749)', async (_name, over) => {
      await setup({ appVersion: sha(0) });
      const target = await open(adapter());
      const release = await approved();
      h.repos.releases.insert({ ...release, id: 'rel_foreign', ...over }, '2026-01-01T00:00:00.000Z');
      const refused = { ok: false, error: { code: 'release_not_configured' } };
      for (const request of [
        { op: 'release_get', releaseId: 'rel_foreign' },
        { op: 'release_claim', releaseId: 'rel_foreign', previousCommit: null },
        { op: 'release_report', releaseId: 'rel_foreign', report: { outcome: 'live' } },
      ] as const)
        expect(await sendControlRequest(target, request), request.op).toMatchObject(refused);
      expect(h.domain.releases.get('rel_foreign').state).toBe(over.state);
      expect(h.domain.releases.get(release.id).state).toBe('approved');
    });

    it('is not configured on a socket without a release dependency', async () => {
      const target = await open(undefined);
      expect(await sendControlRequest(target, { op: 'release_next' })).toMatchObject({
        ok: false,
        error: { code: 'release_not_configured' },
      });
    });

    it('is not configured when the instance has no release target', async () => {
      await setup({ target: false });
      const target = await open(adapter());
      expect(await sendControlRequest(target, { op: 'release_next' })).toMatchObject({
        ok: false,
        error: { code: 'release_not_configured' },
      });
    });
  });

  describe('the roadmap check offered to the Operator (PM-497)', () => {
    const notes = () =>
      h.repos.messages.list('AR', { member: 'operator' }).filter((message) => message.from === 'system');

    it('sends the Operator one info note when a release is proposed, which wakes nobody', async () => {
      await setup();
      const { release } = await propose({ title: 'Autumn release' });
      expect(notes()).toHaveLength(1);
      expect(notes()[0]).toMatchObject({
        kind: 'info',
        to: ['operator'],
        taskKey: null,
        body: expect.stringContaining(`Autumn release (${release.id}) was proposed`),
      });
      expect(notes()[0]!.body).toContain('only after the owner says yes');
      expect(h.domain.sessions.list('AR', { member: 'operator' })).toEqual([]);
    });

    it('does not send a release its note a second time', async () => {
      await setup();
      const { release } = await propose();
      await h.domain.ctx.events.emit('release_proposed', { release });
      expect(notes()).toHaveLength(1);
    });

    it('sends a note for the next release too', async () => {
      await setup();
      await propose();
      await decide('reject');
      await propose({ title: 'Second' });
      expect(notes()).toHaveLength(2);
    });

    it('sends nothing for another state of the release', async () => {
      await setup();
      await approved();
      const before = notes().length;
      const [release] = h.domain.releases.list('AR');
      await h.domain.ctx.events.emit('release_proposed', { release: { ...release!, state: 'approved' } });
      expect(notes()).toHaveLength(before);
    });

    it('sends nothing without a roadmap path', async () => {
      await setup({ roadmap: false });
      await propose();
      expect(notes()).toEqual([]);
    });

    it('sends nothing without an Operator', async () => {
      await setup();
      const { release } = await propose();
      const config = structuredClone(await h.domain.projects.config('AR'));
      config.team.members = config.team.members.filter((member) => !isOperator(member));
      const send = vi.fn();
      const notices = new ReleaseRoadmapNotices({
        ctx: h.domain.ctx,
        projects: { config: async () => config } as unknown as ProjectService,
        messaging: { send } as unknown as Messaging,
      });
      await notices.proposed({ release: { ...release, id: 'rel_other' } });
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('the propose_release tool', () => {
    beforeEach(async () => setup());

    it('records the release and returns the ids', async () => {
      const result = await h.domain.teamTools.proposeRelease(devops, { title: 'Release', summary: '- AR-1' });
      expect(result).toMatchObject({ taskKey: 'AR-4', commit: sha(3), releaseId: expect.any(String) });
      expect(result.tasks).toHaveLength(3);
      expect(h.repos.releases.open('AR')?.id).toBe(result.releaseId);
    });

    it('previews without recording', async () => {
      const result = await h.domain.teamTools.proposeRelease(devops, {
        title: 'Release',
        summary: 'x',
        preview: true,
      });
      expect(result).toMatchObject({ commit: sha(3), baseCommit: null });
      expect(result).not.toHaveProperty('releaseId');
      expect(h.repos.releases.list('AR')).toEqual([]);
    });

    it('says what is wrong in the error text, and refuses a member without the duty', async () => {
      await h.domain.teamTools.proposeRelease(devops, { title: 'Release', summary: 'x' });
      await expect(
        h.domain.teamTools.proposeRelease(devops, { title: 'Again', summary: 'x' }),
      ).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('release_open') });
      await expect(
        h.domain.teamTools.proposeRelease({ ...devops, member: 'dev-1' }, { title: 'x', summary: 'x' }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
  });

  describe('the integrator in super mode proposes (PM-784)', () => {
    const KEY = { id: 'ikey_one', prefix: 'pmi_abcdefgh' };
    beforeEach(async () => setup());

    /** A live scope of a key, as the authenticated facade makes it; `revoked` turns true when the key goes. */
    async function scope(mode: 'super' | 'read' = 'super', revoked: () => boolean = () => false) {
      const actor = superActorOf(await h.domain.projects.config('AR'), KEY)!;
      return {
        active: true,
        context: {
          principal: {
            kind: 'integrator' as const,
            userId: 'usr_owner',
            keyId: KEY.id,
            prefix: KEY.prefix,
            mode,
          },
          projectKey: 'AR',
          actor,
          requestId: 'req-rel-1',
        },
        actorFor: () => {
          if (revoked()) throw forbidden('insufficient_access', 'the key was revoked');
          return actor;
        },
        assertAccess: () => undefined,
        assertMutation: () => {},
        authorizeMutation: async () => {},
      } satisfies IntegratorExecutionScope;
    }
    const inScope = <T>(s: IntegratorExecutionScope, run: () => Promise<T>) => runIntegratorExecution(s, run);
    const superActor = () => ({
      kind: 'ai',
      handle: 'operator',
      via: 'integrator',
      operatorMode: 'super',
      credential: KEY,
    });

    it('previews the candidate and records nothing', async () => {
      const candidate = await inScope(await scope(), () => h.domain.releases.previewExternal('AR'));
      expect(candidate).toMatchObject({ repo: 'web', commit: sha(3), baseCommit: null });
      expect(candidate.tasks.map((card) => card.key)).toEqual(['AR-1', 'AR-2', 'AR-3']);
      const chosen = await inScope(await scope(), () => h.domain.releases.previewExternal('AR', sha(2)));
      expect(chosen.tasks.map((card) => card.key)).toEqual(['AR-1', 'AR-2']);
      expect(h.repos.releases.list('AR')).toEqual([]);
      expect(h.domain.inbox.list('AR', { kind: 'release' })).toEqual([]);
      expect(h.domain.tasks.list('AR').filter((card) => card.kind === 'theme')).toEqual([]);
    });

    it('proposes as the Operator through the key, for the owners’ approval, without the duty check', async () => {
      const { release, candidate } = await inScope(await scope(), () =>
        h.domain.releases.proposeExternal('AR', { title: 'Super release', summary: '- AR-1' }),
      );
      expect(release).toMatchObject({
        state: 'proposed',
        commit: sha(3),
        tasks: ['AR-1', 'AR-2', 'AR-3'],
        proposedBy: 'operator',
        taskKey: 'AR-4',
      });
      expect(candidate.tasks).toHaveLength(3);
      expect(task('AR-4')).toMatchObject({ kind: 'theme', title: 'Super release' });
      const items = h.domain.inbox.list('AR', { kind: 'release', state: 'open' });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ assignees: ['owner'], taskKey: 'AR-4', source: 'operator' });
      // The events carry the whole actor of the key, never only the handle.
      const created = h.domain.timeline
        .list('AR', { taskKey: 'AR-4' })
        .filter((event) => event.type === 'task_created');
      expect(created.map((event) => event.actor)).toEqual([superActor()]);
      expect(events('AR-4').map((event) => event.actor)).toEqual([superActor()]);
      expect(events('AR-4')[0]!.data).toMatchObject({ state: 'proposed', previousState: null });
    });

    it('stays a proposal: neither the key nor the proposal approves, and the owner’s own login does', async () => {
      await inScope(await scope(), () =>
        h.domain.releases.proposeExternal('AR', { title: 'Super release', summary: 'x' }),
      );
      await expect(inScope(await scope(), async () => decide('approve', OWNER))).rejects.toMatchObject({
        code: 'owner_approval_required',
      });
      expect(h.repos.releases.open('AR')).toMatchObject({ state: 'proposed' });
      await decide('approve', OWNER);
      expect(h.repos.releases.open('AR')).toMatchObject({ state: 'approved', decidedBy: 'owner' });
    });

    it('refuses an open release, a read key and a call outside a scope, and writes nothing', async () => {
      await inScope(await scope(), () =>
        h.domain.releases.proposeExternal('AR', { title: 'First', summary: 'x' }),
      );
      await expect(
        inScope(await scope(), () =>
          h.domain.releases.proposeExternal('AR', { title: 'Second', summary: 'x' }),
        ),
      ).rejects.toMatchObject({ code: 'release_open', status: 409 });
      await expect(
        inScope(await scope(), () => h.domain.releases.previewExternal('AR')),
      ).rejects.toMatchObject({ code: 'release_open' });
      await decide('reject');
      for (const [mode, code] of [['read', 'integrator_read_only']] as const) {
        await expect(
          inScope(await scope(mode), () =>
            h.domain.releases.proposeExternal('AR', { title: 'No', summary: 'x' }),
          ),
          mode,
        ).rejects.toMatchObject({ code });
        await expect(
          inScope(await scope(mode), () => h.domain.releases.previewExternal('AR')),
          mode,
        ).rejects.toMatchObject({ code });
      }
      await expect(
        h.domain.releases.proposeExternal('AR', { title: 'No scope', summary: 'x' }),
      ).rejects.toMatchObject({ code: 'insufficient_access' });
      expect(h.repos.releases.list('AR')).toHaveLength(1);
      expect(h.domain.tasks.list('AR').filter((card) => card.kind === 'theme')).toHaveLength(1);
    });

    it('checks the key again after the candidate is read, and a key revoked meanwhile records nothing', async () => {
      // The first check opens the lock, the candidate is read, and the key is gone at the second check.
      let checks = 0;
      const s = await scope('super', () => ++checks >= 2);
      await expect(
        inScope(s, () => h.domain.releases.proposeExternal('AR', { title: 'Late', summary: 'x' })),
      ).rejects.toMatchObject({ code: 'insufficient_access' });
      expect(h.repos.releases.list('AR')).toEqual([]);
      expect(h.domain.inbox.list('AR', { kind: 'release' })).toEqual([]);
      expect(h.domain.tasks.list('AR').filter((card) => card.kind === 'theme')).toEqual([]);
    });
  });
});
