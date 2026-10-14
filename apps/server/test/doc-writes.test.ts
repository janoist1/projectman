import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig, Session } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { BranchMerger, ToolContext } from '../src/contracts';
import { waitFor } from '../src/runner/test-helpers';
import { createDomainHarness, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { settle } from './helpers/fakes';

let h: DomainHarness;
afterEach(async () => {
  await h?.cleanup();
});

const BASE = 'b'.repeat(40);
const DECISIONS = 'docs/DECISIONS.md';
const ROADMAP = 'docs/ROADMAP.md';
const LOG = '# Decisions\n1. First\n2. Second\n';

/**
 * A repository's default branch as a map of commits to files. `readFile` of a base is the remote head;
 * `commitFiles` makes `w1`, `w2`, ...; `push` and `advance` move the heads.
 */
function fakeDocsMerger(initial: Record<string, string> = { [DECISIONS]: LOG, [ROADMAP]: '# Roadmap\n' }) {
  const trees = new Map<string, Record<string, string>>([[BASE, initial]]);
  const state = {
    local: BASE,
    remote: BASE as string,
    localHas: new Set([BASE]),
    remoteHas: new Set([BASE]),
  };
  let made = 0;
  const merger = {
    state,
    trees,
    prepare: vi.fn<BranchMerger['prepare']>(async (_ref, input) => ({
      local: state.local,
      remote: { name: 'origin', commit: state.remote },
      relation: state.local === state.remote ? 'same' : 'local_behind',
      contains: { local: state.localHas.has(input.commit), remote: state.remoteHas.has(input.commit) },
      checkout: null,
    })),
    isAncestor: vi.fn<BranchMerger['isAncestor']>(async () => false),
    build: vi.fn<BranchMerger['build']>(async () => ({ ok: false, conflict: [] })),
    checkoutConflicts: vi.fn<BranchMerger['checkoutConflicts']>(async () => []),
    checkoutForCheck: vi.fn<BranchMerger['checkoutForCheck']>(async () => ({ path: '/x', gitDir: '/y' })),
    releaseCheck: vi.fn<BranchMerger['releaseCheck']>(async () => {}),
    push: vi.fn<BranchMerger['push']>(async (_ref, input) => {
      state.remote = input.mergeCommit;
      state.remoteHas.add(input.mergeCommit);
      return { ok: true };
    }),
    advance: vi.fn<BranchMerger['advance']>(async (_ref, input) => {
      state.local = input.to;
      state.localHas.add(input.to);
      return { ok: true };
    }),
    readFile: vi.fn<BranchMerger['readFile']>(async (_ref, input) => {
      const commit = 'commit' in input.at ? input.at.commit : state.remote;
      if (!trees.has(commit)) throw new Error(`unknown commit ${commit}`);
      return { commit, text: trees.get(commit)![input.path] ?? null };
    }),
    commitFiles: vi.fn<BranchMerger['commitFiles']>(async (_ref, input) => {
      const commit = `w${++made}`.padEnd(40, '0');
      const files = { ...trees.get(input.onto) };
      const changed: string[] = [];
      for (const file of input.files) {
        if (files[file.path] !== file.text) changed.push(file.path);
        files[file.path] = file.text;
      }
      trees.set(commit, files);
      return { commit, changed };
    }),
    listPaths: vi.fn<BranchMerger['listPaths']>(async () => ({
      commit: 'e'.repeat(40),
      paths: [],
      truncated: false,
    })),
    changedPaths: vi.fn<BranchMerger['changedPaths']>(async () => []),
  };
  return merger;
}

function withDocs(config: ProjectConfig): void {
  config.project.repos[0]!.docs = { decisions: DECISIONS, roadmap: ROADMAP };
}

async function setup(
  merger: ReturnType<typeof fakeDocsMerger> | null = fakeDocsMerger(),
  opts: { docs?: boolean; persistent?: boolean } = {},
) {
  h = await createDomainHarness({
    merger,
    persistent: opts.persistent,
    adjust(config) {
      if (opts.docs !== false) withDocs(config);
      config.team.members.push({
        kind: 'human',
        handle: 'cleo',
        displayName: 'cleo',
        email: 'cleo@example.test',
        access: 'client',
        roles: [],
      });
    },
  });
  return merger;
}

async function say(from: string, text = 'Please update the log') {
  await h.domain.messaging.sendReporting('AR', from, { to: ['operator'], text });
  await settle();
}
const operatorSessions = (): Session[] => h.domain.sessions.list('AR', { member: 'operator' });
const ownerConversation = (): Session =>
  operatorSessions().find((s) => s.workItem.type === 'general' && s.workItem.with === undefined)!;
const toolOf = (session: Session): ToolContext => ({
  projectKey: 'AR',
  member: 'operator',
  sessionId: session.id,
  taskKey: null,
});
/** The owner asks the Operator something: its conversation and an open request. */
async function ownerAsks(): Promise<{ ctx: ToolContext; requestId: string }> {
  await say('owner');
  const session = ownerConversation();
  return { ctx: toolOf(session), requestId: h.repos.operatorRequests.openOfSession(session.id)[0]!.id };
}
const stepsOf = (requestId: string) => h.repos.operatorRequests.steps(requestId);
const refusal = async (promise: Promise<unknown>) => (await rejection(promise, TeamToolError)).message;
const append = (text: string) => ({ doc: 'decisions' as const, old_text: '', new_text: text });
type Edit = { doc: 'decisions' | 'roadmap'; old_text: string; new_text: string };
const write = (ctx: ToolContext, edits: Edit[] = [append('3. Third')], baseCommit = BASE) =>
  h.domain.teamTools.writeProjectDocs(ctx, { baseCommit, message: 'Add decision 3', edits });

describe('read_project_doc (PM-495)', () => {
  it('reads the lines asked for at the head of the default branch, with the commit', async () => {
    const merger = await setup();
    const { ctx } = await ownerAsks();
    const all = await h.domain.teamTools.readProjectDoc(ctx, { doc: 'decisions' });
    expect(all).toEqual({
      doc: 'decisions',
      repo: expect.any(String),
      path: DECISIONS,
      commit: BASE,
      exists: true,
      total_lines: 3,
      from_line: 1,
      text: '# Decisions\n1. First\n2. Second',
    });
    expect(merger!.readFile).toHaveBeenLastCalledWith(expect.anything(), {
      at: { base: expect.any(String) },
      path: DECISIONS,
    });
    expect(
      await h.domain.teamTools.readProjectDoc(ctx, { doc: 'decisions', fromLine: 2, lineCount: 1 }),
    ).toMatchObject({ from_line: 2, total_lines: 3, text: '1. First' });
  });

  it('says a file that is not in the repository yet does not exist', async () => {
    await setup(fakeDocsMerger({ [DECISIONS]: LOG }));
    const { ctx } = await ownerAsks();
    expect(await h.domain.teamTools.readProjectDoc(ctx, { doc: 'roadmap' })).toMatchObject({
      exists: false,
      total_lines: 0,
      text: '',
    });
  });

  it('needs no open request, and is the Operator’s only', async () => {
    await setup();
    const { ctx, requestId } = await ownerAsks();
    h.repos.operatorRequests.close(requestId, new Date().toISOString());
    expect(await h.domain.teamTools.readProjectDoc(ctx, { doc: 'decisions' })).toMatchObject({
      exists: true,
    });
    expect(
      await refusal(h.domain.teamTools.readProjectDoc({ ...ctx, member: 'dev-1' }, { doc: 'decisions' })),
    ).toMatch(/^operator_only:/);
  });

  it('is refused when the project has no documents set up', async () => {
    await setup(fakeDocsMerger(), { docs: false });
    const { ctx } = await ownerAsks();
    expect(await refusal(h.domain.teamTools.readProjectDoc(ctx, { doc: 'decisions' }))).toMatch(
      /^docs_not_configured:/,
    );
  });
});

describe('write_project_docs (PM-495)', () => {
  it('publishes one commit with the trailers, pushes it and moves the local branch', async () => {
    const merger = (await setup())!;
    const { ctx, requestId } = await ownerAsks();
    const result = await write(ctx);
    expect(result).toEqual({
      write_id: expect.stringMatching(/^dw_/),
      state: 'published',
      commit: 'w1'.padEnd(40, '0'),
      paths: [DECISIONS],
    });
    expect(merger.trees.get('w1'.padEnd(40, '0'))![DECISIONS]).toBe(`${LOG}3. Third`);
    const input = merger.commitFiles.mock.calls[0]![1];
    expect(input.onto).toBe(BASE);
    expect(input.message).toBe(
      `Add decision 3\n\nProjectman-Operator: operator\nProjectman-Request: ${requestId}\nProjectman-Requested-By: owner`,
    );
    expect(merger.push).toHaveBeenCalledWith(expect.anything(), {
      base: expect.any(String),
      mergeCommit: 'w1'.padEnd(40, '0'),
    });
    expect(merger.advance).toHaveBeenCalledWith(expect.anything(), {
      base: expect.any(String),
      from: BASE,
      to: 'w1'.padEnd(40, '0'),
    });
    expect(stepsOf(requestId)).toMatchObject([{ action: 'docs_write', status: 'done' }]);
    expect(h.repos.docWrites.get(result.write_id)).toMatchObject({
      state: 'published',
      commitSha: 'w1'.padEnd(40, '0'),
      author: 'operator',
      requestedBy: 'owner',
    });
    // The answer was the tool's: no message follows.
    expect(h.repos.messages.list('AR', { member: 'operator' }).filter((m) => m.from === 'system')).toEqual(
      [],
    );
  });

  it('writes both files in one commit', async () => {
    const merger = (await setup())!;
    const { ctx } = await ownerAsks();
    const result = await write(ctx, [
      append('3. Third'),
      { doc: 'roadmap', old_text: '# Roadmap', new_text: '# Roadmap (2026)' },
    ]);
    expect(result).toMatchObject({ state: 'published', paths: [DECISIONS, ROADMAP] });
    expect(merger.commitFiles).toHaveBeenCalledTimes(1);
  });

  it('allows a line inserted in the middle of the decision log', async () => {
    await setup();
    const { ctx } = await ownerAsks();
    const result = await write(ctx, [
      { doc: 'decisions', old_text: '1. First\n', new_text: '1. First\n   (note: confirmed)\n' },
    ]);
    expect(result).toMatchObject({ state: 'published' });
  });

  it.each([
    ['a changed line', { doc: 'decisions' as const, old_text: '2. Second', new_text: '2. Changed' }],
    ['a removed line', { doc: 'decisions' as const, old_text: '1. First\n', new_text: '' }],
  ])('refuses %s in the decision log, and queues nothing', async (_name, edit) => {
    await setup();
    const { ctx, requestId } = await ownerAsks();
    expect(await refusal(write(ctx, [edit]))).toMatch(/^docs_not_append_only:/);
    expect(h.repos.docWrites.openOf('AR')).toBeNull();
    expect(stepsOf(requestId)).toMatchObject([{ action: 'docs_write', status: 'refused' }]);
    expect(stepsOf(requestId)[0]!.refusal).toMatchObject({ code: 'docs_not_append_only' });
  });

  it('may rewrite the roadmap', async () => {
    await setup();
    const { ctx } = await ownerAsks();
    expect(await write(ctx, [{ doc: 'roadmap', old_text: '# Roadmap', new_text: '# Plan' }])).toMatchObject({
      state: 'published',
      paths: [ROADMAP],
    });
  });

  it('refuses an old_text that is not in the file, or is there twice', async () => {
    await setup(fakeDocsMerger({ [DECISIONS]: LOG, [ROADMAP]: 'a\na\n' }));
    const { ctx } = await ownerAsks();
    expect(await refusal(write(ctx, [{ doc: 'decisions', old_text: 'nope', new_text: 'x' }]))).toMatch(
      /^docs_edit_not_found:/,
    );
    expect(await refusal(write(ctx, [{ doc: 'roadmap', old_text: 'a', new_text: 'b' }]))).toMatch(
      /^docs_edit_ambiguous:/,
    );
  });

  it('refuses edits that change nothing', async () => {
    await setup();
    const { ctx } = await ownerAsks();
    expect(
      await refusal(write(ctx, [{ doc: 'roadmap', old_text: '# Roadmap', new_text: '# Roadmap' }])),
    ).toMatch(/^docs_unchanged:/);
  });

  it('refuses a commit the engine does not know', async () => {
    await setup();
    const { ctx } = await ownerAsks();
    await expect(write(ctx, [append('x')], 'f'.repeat(40))).rejects.toThrow();
    expect(h.repos.docWrites.openOf('AR')).toBeNull();
  });

  it('is refused when the project has no documents set up', async () => {
    await setup(fakeDocsMerger(), { docs: false });
    const { ctx } = await ownerAsks();
    expect(await refusal(write(ctx))).toMatch(/^docs_not_configured:/);
  });

  it('is refused when the engine cannot merge', async () => {
    await setup(null);
    const { ctx } = await ownerAsks();
    expect(await refusal(write(ctx))).toMatch(/^engine_offline:/);
  });

  describe('who may write', () => {
    it('refuses a call without an open request', async () => {
      const merger = (await setup())!;
      const { ctx, requestId } = await ownerAsks();
      h.repos.operatorRequests.close(requestId, new Date().toISOString());
      expect(await refusal(write(ctx))).toMatch(/^operator_no_request:/);
      expect(merger.commitFiles).not.toHaveBeenCalled();
    });

    it('refuses a member who is not the Operator', async () => {
      await setup();
      const { ctx } = await ownerAsks();
      expect(await refusal(write({ ...ctx, member: 'dev-1' }))).toMatch(/^operator_only:/);
    });

    it('refuses a conversation with someone who is not an owner', async () => {
      const merger = (await setup())!;
      await say('cleo', 'Please change the log');
      const session = await waitFor(
        () => operatorSessions().find((s) => s.workItem.type === 'general' && s.workItem.with === 'cleo'),
        { what: 'the Operator conversation with cleo' },
      );
      const request = await waitFor(() => h.repos.operatorRequests.openOfSession(session.id)[0], {
        what: 'the open Operator request from cleo',
      });
      expect(await refusal(write(toolOf(session)))).toMatch(/^operator_owner_only:/);
      expect(merger.commitFiles).not.toHaveBeenCalled();
      expect(stepsOf(request.id)).toMatchObject([
        { action: 'docs_write', status: 'refused', refusal: { code: 'operator_owner_only' } },
      ]);
    });
  });

  describe('the repository slot', () => {
    it('refuses a second write while one is open', async () => {
      await setup();
      const { ctx } = await ownerAsks();
      vi.spyOn(h.domain.merges, 'busy').mockReturnValue(true);
      vi.spyOn(h.domain.merges, 'holder').mockReturnValue('AR-1');
      expect(await write(ctx)).toMatchObject({ state: 'queued', waiting_for: 'AR-1' });
      expect(await refusal(write(ctx, [append('4. Fourth')]))).toMatch(/^docs_write_pending:/);
    });

    it('queues behind a merge, runs when the slot frees, and tells the Operator how it ended', async () => {
      const merger = (await setup())!;
      const { ctx, requestId } = await ownerAsks();
      const busy = vi.spyOn(h.domain.merges, 'busy').mockReturnValue(true);
      vi.spyOn(h.domain.merges, 'holder').mockReturnValue('AR-1');
      const queued = await write(ctx);
      expect(queued).toMatchObject({ state: 'queued', waiting_for: 'AR-1' });
      expect(merger.commitFiles).not.toHaveBeenCalled();
      expect(stepsOf(requestId)).toMatchObject([{ action: 'docs_write', status: 'queued' }]);
      expect(h.repos.docWrites.get(queued.write_id)).toMatchObject({ state: 'queued' });

      busy.mockReturnValue(false);
      h.domain.docWrites.pump();
      await settle();

      expect(h.repos.docWrites.get(queued.write_id)).toMatchObject({ state: 'published' });
      expect(stepsOf(requestId)).toMatchObject([{ action: 'docs_write', status: 'done' }]);
      const messages = h.repos.messages.list('AR', { member: 'operator' }).filter((m) => m.from === 'system');
      expect(messages).toMatchObject([
        { kind: 'info', taskKey: null, body: expect.stringContaining('w1'.padEnd(40, '0')) },
      ]);
    });

    it('holds the slot while it runs: a merge waits, and gets its turn at the end', async () => {
      const merger = (await setup())!;
      const { ctx } = await ownerAsks();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const push = merger.push.getMockImplementation()!;
      merger.push.mockImplementationOnce(async (ref, input) => {
        await gate;
        return push(ref, input);
      });
      const pumped = vi.spyOn(h.domain.merges, 'pump');
      const pending = write(ctx);
      await settle();
      const open = h.repos.docWrites.openOf('AR')!;
      expect(open.state).toBe('running');
      expect(h.domain.docWrites.busy('AR', open.repo)).toBe(true);
      release();
      expect(await pending).toMatchObject({ state: 'published' });
      expect(h.domain.docWrites.busy('AR', open.repo)).toBe(false);
      expect(pumped).toHaveBeenCalled();
    });

    it('answers running when the write is not over in time, and the message tells the result', async () => {
      const merger = (await setup())!;
      const { ctx, requestId } = await ownerAsks();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const push = merger.push.getMockImplementation()!;
      merger.push.mockImplementationOnce(async (ref, input) => {
        await gate;
        return push(ref, input);
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const pending = write(ctx);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await pending).toMatchObject({ state: 'running' });
      } finally {
        vi.useRealTimers();
      }
      release();
      await settle();
      expect(stepsOf(requestId)).toMatchObject([{ status: 'done' }]);
      const messages = h.repos.messages.list('AR', { member: 'operator' }).filter((m) => m.from === 'system');
      expect(messages).toHaveLength(1);
    });
  });

  describe('when the repository moved or the push fails', () => {
    it('refuses with docs_stale, and marks the step stale, when a file changed since base_commit', async () => {
      const merger = (await setup())!;
      const { ctx, requestId } = await ownerAsks();
      const moved = 'e'.repeat(40);
      merger.trees.set(moved, { [DECISIONS]: `${LOG}3. Someone else\n`, [ROADMAP]: '# Roadmap\n' });
      merger.state.remote = moved;
      merger.state.local = moved;
      expect(await refusal(write(ctx))).toMatch(/^docs_stale:/);
      expect(merger.commitFiles).not.toHaveBeenCalled();
      expect(stepsOf(requestId)).toMatchObject([{ action: 'docs_write', status: 'stale' }]);
      expect(h.repos.docWrites.openOf('AR')).toBeNull();
    });

    it('writes onto a newer head when the files it touches did not change', async () => {
      const merger = (await setup())!;
      const { ctx } = await ownerAsks();
      const moved = 'e'.repeat(40);
      merger.trees.set(moved, { [DECISIONS]: LOG, [ROADMAP]: '# Roadmap\n', 'other.txt': 'x' });
      merger.state.remote = moved;
      merger.state.local = moved;
      expect(await write(ctx)).toMatchObject({ state: 'published' });
      expect(merger.commitFiles.mock.calls[0]![1].onto).toBe(moved);
    });

    it('builds again once when the push is not a fast-forward', async () => {
      const merger = (await setup())!;
      const { ctx } = await ownerAsks();
      const push = merger.push.getMockImplementation()!;
      merger.push.mockImplementationOnce(async () => ({
        ok: false,
        reason: 'non_fast_forward',
        message: 'behind',
      }));
      expect(await write(ctx)).toMatchObject({ state: 'published' });
      expect(merger.push).toHaveBeenCalledTimes(2);
      expect(merger.commitFiles).toHaveBeenCalledTimes(2);
      expect(push).toBeDefined();
    });

    it('fails with remote_moved when the second push is not a fast-forward either', async () => {
      const merger = (await setup())!;
      const { ctx, requestId } = await ownerAsks();
      merger.push.mockResolvedValue({ ok: false, reason: 'non_fast_forward', message: 'behind' });
      expect(await refusal(write(ctx))).toMatch(/^docs_write_failed: remote_moved/);
      expect(merger.push).toHaveBeenCalledTimes(2);
      expect(merger.advance).not.toHaveBeenCalled();
      expect(stepsOf(requestId)).toMatchObject([{ status: 'refused' }]);
      expect(stepsOf(requestId)[0]!.refusal).toMatchObject({ code: 'docs_write_failed' });
      expect(h.repos.docWrites.openOf('AR')).toBeNull();
    });

    it.each([
      ['rejected', 'push_rejected'],
      ['unreachable', 'remote_unreachable'],
    ] as const)('names a %s push %s', async (reason, failure) => {
      const merger = (await setup())!;
      const { ctx } = await ownerAsks();
      merger.push.mockResolvedValue({ ok: false, reason, message: 'no' });
      expect(await refusal(write(ctx))).toMatch(new RegExp(`^docs_write_failed: ${failure}`));
    });

    it('fails with checkout_conflict when uncommitted files are in the way, before the push', async () => {
      const merger = (await setup())!;
      const { ctx } = await ownerAsks();
      merger.checkoutConflicts.mockResolvedValue([DECISIONS]);
      expect(await refusal(write(ctx))).toMatch(/^docs_write_failed: checkout_conflict/);
      expect(merger.push).not.toHaveBeenCalled();
    });

    it('fails with base_out_of_sync when the local branch is ahead or diverged', async () => {
      const merger = (await setup())!;
      const { ctx } = await ownerAsks();
      merger.prepare.mockResolvedValue({
        local: BASE,
        remote: { name: 'origin', commit: BASE },
        relation: 'diverged',
        contains: { local: true, remote: true },
        checkout: null,
      });
      expect(await refusal(write(ctx))).toMatch(/^docs_write_failed: base_out_of_sync/);
      expect(merger.commitFiles).not.toHaveBeenCalled();
    });

    it('is published with a warning when only the local checkout could not follow', async () => {
      const merger = (await setup())!;
      const { ctx } = await ownerAsks();
      merger.advance.mockResolvedValue({
        ok: false,
        reason: 'checkout_in_the_way',
        message: 'dirty',
        paths: [],
      });
      const result = await write(ctx);
      expect(result).toMatchObject({
        state: 'published',
        warning: expect.stringContaining('local checkout'),
      });
      expect(merger.state.remoteHas.has((result as { commit: string }).commit)).toBe(true);
    });
  });

  describe('after a restart', () => {
    /** A write the last server left running, with the Operator’s request and step it belongs to. */
    async function leaveRunning(commitSha: string | null) {
      const merger = (await setup(fakeDocsMerger(), { persistent: true }))!;
      const { requestId } = await ownerAsks();
      const now = new Date().toISOString();
      h.repos.operatorRequests.insertStep({
        id: 'ops_left',
        requestId,
        at: now,
        action: 'docs_write',
        status: 'queued',
        taskKey: null,
        member: null,
        changes: [],
        configVersion: null,
        inboxItemId: null,
        signalId: null,
        refusal: null,
      });
      h.repos.docWrites.insert({
        id: 'dw_left',
        projectKey: 'AR',
        repo: h.domain.projects.summaries().length ? await repoName() : '',
        base: 'main',
        baseCommit: BASE,
        edits: [{ path: DECISIONS, old_text: '', new_text: '3. Third' }],
        message: 'Add decision 3\n\nProjectman-Operator: operator',
        author: 'operator',
        requestedBy: 'owner',
        requestId,
        stepId: 'ops_left',
        engineId: 'local',
        state: 'running',
        commitSha,
        error: null,
        createdAt: now,
        updatedAt: now,
      });
      return { merger, requestId };
    }
    async function repoName(): Promise<string> {
      return (await h.domain.projects.config('AR')).project.repos[0]!.name;
    }

    it('publishes a write whose commit is already on the remote, and advances the local branch', async () => {
      const { merger, requestId } = await leaveRunning('c'.repeat(40));
      merger.trees.set('c'.repeat(40), { [DECISIONS]: `${LOG}3. Third` });
      merger.state.remote = 'c'.repeat(40);
      merger.state.remoteHas.add('c'.repeat(40));
      h = await restartDomainHarness(h, { merger });
      await settle();
      expect(h.repos.docWrites.get('dw_left')).toMatchObject({
        state: 'published',
        commitSha: 'c'.repeat(40),
      });
      expect(merger.advance).toHaveBeenCalledWith(expect.anything(), {
        base: 'main',
        from: BASE,
        to: 'c'.repeat(40),
      });
      expect(merger.push).not.toHaveBeenCalled();
      expect(stepsOf(requestId)).toMatchObject([{ id: 'ops_left', status: 'done' }]);
      const messages = h.repos.messages.list('AR', { member: 'operator' }).filter((m) => m.from === 'system');
      expect(messages).toMatchObject([{ kind: 'info', body: expect.stringContaining('c'.repeat(40)) }]);
    });

    it('queues a write again, and runs it, when its commit is not on the remote', async () => {
      const { merger } = await leaveRunning('c'.repeat(40));
      h = await restartDomainHarness(h, { merger });
      await settle();
      expect(h.repos.docWrites.get('dw_left')).toMatchObject({
        state: 'published',
        commitSha: 'w1'.padEnd(40, '0'),
      });
      expect(merger.push).toHaveBeenCalledTimes(1);
    });

    it('runs a write that never got as far as a commit', async () => {
      const { merger } = await leaveRunning(null);
      h = await restartDomainHarness(h, { merger });
      await settle();
      expect(h.repos.docWrites.get('dw_left')).toMatchObject({ state: 'published' });
    });
  });
});
