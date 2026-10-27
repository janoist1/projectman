import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { operatorQueueAvailable, superActorOf } from '@projectman/shared';
import type { ProjectConfig, ProjectDoc, Session } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type {
  BranchMerger,
  DocWriteExternalRunner,
  EngineDirectory,
  EngineHost,
  IntegratorExecutionScope,
  ToolContext,
} from '../src/contracts';
import { createDomainContext } from '../src/core/base';
import { runIntegratorExecution } from '../src/kernel';
import { createRepositories, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';
import { DocWrites } from '../src/services/project-docs';
import { waitFor } from '../src/runner/test-helpers';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
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
const LESSONS = 'docs/LESSONS.md';
const LOG = '# Decisions\n1. First\n2. Second\n';

/**
 * A repository's default branch as a map of commits to files. `readFile` of a base is the remote head;
 * `commitFiles` makes `w1`, `w2`, ...; `push` and `advance` move the heads.
 */
function fakeDocsMerger(
  initial: Record<string, string> = {
    'docs/DECISIONS.md': '# Decisions\n1. First\n2. Second\n',
    'docs/ROADMAP.md': '# Roadmap\n',
  },
) {
  const BASE = 'b'.repeat(40);
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
    remoteTags: vi.fn(),
    pushTag: vi.fn(),
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
    commitRegenerated: vi.fn<BranchMerger['commitRegenerated']>(),
  };
  return merger;
}

function withDocs(config: ProjectConfig): void {
  config.project.repos[0]!.docs = { decisions: DECISIONS, roadmap: ROADMAP, lessons: LESSONS };
}

async function setup(
  merger: ReturnType<typeof fakeDocsMerger> | null = fakeDocsMerger(),
  opts: { docs?: boolean; persistent?: boolean; pm?: boolean } = {},
) {
  h = await createDomainHarness({
    merger,
    integratorTodoAccess: { available: operatorQueueAvailable },
    persistent: opts.persistent,
    adjust(config) {
      if (opts.docs !== false) withDocs(config);
      if (opts.pm) {
        const pm = config.team.members.find((member) => member.handle === 'pm');
        if (pm?.kind === 'ai') pm.onLeave = false;
      }
      config.team.members.push({
        kind: 'human',
        handle: 'cleo',
        displayName: 'cleo',
        email: 'cleo@example.test',
        access: 'client',
        roles: [],
      });
      // A client may message only the contacts.
      config.team.contacts = ['operator'];
    },
  });
  return merger;
}

async function say(from: string, text = 'Please update the log', to = 'operator') {
  await h.domain.messaging.sendReporting('AR', from, { to: [to], text });
  await settle();
}
const operatorSessions = (): Session[] => h.domain.sessions.list('AR', { member: 'operator' });
/** The member's general conversation with the owner; the session starts asynchronously. */
const ownerConversation = (member = 'operator'): Promise<Session> =>
  waitFor(
    () =>
      h.domain.sessions
        .list('AR', { member })
        .find((s) => s.workItem.type === 'general' && s.workItem.with === undefined),
    { what: `the ${member} conversation with the owner` },
  );
const toolOf = (session: Session): ToolContext => ({
  projectKey: 'AR',
  member: session.member,
  sessionId: session.id,
  taskKey: null,
});
/** The owner asks the document maintainer something: its conversation and an open request. */
async function ownerAsks(member = 'operator'): Promise<{ ctx: ToolContext; requestId: string }> {
  await say('owner', undefined, member);
  const session = await ownerConversation(member);
  const request = await waitFor(() => h.repos.operatorRequests.openOfSession(session.id)[0], {
    what: `the open request of the ${member} conversation`,
  });
  return { ctx: toolOf(session), requestId: request.id };
}
const stepsOf = (requestId: string) => h.repos.operatorRequests.steps(requestId);
const refusal = async (promise: Promise<unknown>) => (await rejection(promise, TeamToolError)).message;
const append = (text: string) => ({ doc: 'decisions' as const, old_text: '', new_text: text });
type Edit = { doc: ProjectDoc; old_text: string; new_text: string };
const write = (ctx: ToolContext, edits: Edit[] = [append('3. Third')], baseCommit = BASE) =>
  h.domain.teamTools.writeProjectDocs(ctx, { baseCommit, message: 'Add decision 3', edits });

describe('project manager documents (PM-1044)', () => {
  async function internal(): Promise<ToolContext> {
    const { session } = await h.domain.sessions.ensureSession('AR', 'pm', { type: 'general' });
    await settle();
    return toolOf(session);
  }

  it('reads and publishes decisions and roadmap for its own owner request', async () => {
    await setup(fakeDocsMerger(), { pm: true });
    const { ctx, requestId } = await ownerAsks('pm');
    const read = await h.domain.teamTools.readProjectDoc(ctx, { doc: 'decisions' });
    const result = await write(
      ctx,
      [append('3. Third'), { doc: 'roadmap', old_text: '', new_text: 'Next step' }],
      read.commit,
    );
    expect(result).toMatchObject({ state: 'published', paths: [DECISIONS, ROADMAP] });
    expect(h.repos.docWrites.get(result.write_id)).toMatchObject({
      author: 'pm',
      requestedBy: 'owner',
      requestId,
    });
    expect(stepsOf(requestId)).toMatchObject([{ action: 'docs_write', status: 'done' }]);
  });

  it('reads decisions without an owner request', async () => {
    await setup(fakeDocsMerger(), { pm: true });
    const ctx = await internal();
    expect(await h.domain.teamTools.readProjectDoc(ctx, { doc: 'decisions' })).toMatchObject({
      commit: BASE,
    });
  });

  it('refuses decision writes without an owner request', async () => {
    const merger = (await setup(fakeDocsMerger(), { pm: true }))!;
    expect(await refusal(write(await internal()))).toMatch(/^operator_no_request:/);
    expect(merger.commitFiles).not.toHaveBeenCalled();
  });

  it('does not inherit an owner request sent to the Operator', async () => {
    await setup(fakeDocsMerger(), { pm: true });
    await ownerAsks();
    expect(await refusal(write(await internal()))).toMatch(/^operator_no_request:/);
  });

  it('maintains lessons without an owner request through the publication recheck', async () => {
    await setup(fakeDocsMerger(), { pm: true });
    const ctx = await internal();
    const read = await h.domain.teamTools.readProjectDoc(ctx, { doc: 'lessons' });
    const result = await write(ctx, [{ doc: 'lessons', old_text: '', new_text: 'A lesson' }], read.commit);
    expect(result).toMatchObject({ state: 'published', paths: [LESSONS] });
    expect(h.repos.docWrites.get(result.write_id)).toMatchObject({
      author: 'pm',
      autonomousLessons: true,
      requestId: null,
      requestedBy: null,
    });
  });

  it('refuses documents in the PM guest conversation', async () => {
    await setup(fakeDocsMerger(), { pm: true });
    const { session } = await h.domain.sessions.ensureSession('AR', 'pm', {
      type: 'general',
      with: 'cleo',
    });
    const ctx = toolOf(session);
    await expect(h.domain.teamTools.readProjectDoc(ctx, { doc: 'decisions' })).rejects.toThrow(
      'operator_owner_only',
    );
    await expect(write(ctx)).rejects.toThrow('operator_owner_only');
    await expect(write(ctx, [{ doc: 'lessons', old_text: '', new_text: 'A lesson' }])).rejects.toThrow(
      'operator_owner_only',
    );
  });

  it('refuses a PM who is no longer the selected coordinator', async () => {
    await setup(fakeDocsMerger(), { pm: true });
    const ctx = await internal();
    const pm = h.domain.projects.cachedConfig('AR')!.team.members.find((member) => member.handle === 'pm');
    if (pm?.kind === 'ai') pm.onLeave = true;
    await expect(h.domain.teamTools.readProjectDoc(ctx, { doc: 'decisions' })).rejects.toThrow(
      'operator_only',
    );
    await expect(write(ctx)).rejects.toThrow('operator_only');
  });

  it.each(['decisions', 'lessons'] as const)(
    'refuses %s writes during an approval continuation',
    async (doc) => {
      await setup(fakeDocsMerger(), { pm: true });
      const ctx = await internal();
      h.repos.operatorRequests.insert({
        id: 'opr_pm_approval',
        projectKey: 'AR',
        sessionId: ctx.sessionId,
        source: 'approval',
        messageId: null,
        inboxItemId: null,
        fromHandle: 'owner',
        quote: 'An unrelated approval',
        openedAt: new Date().toISOString(),
      });
      await expect(write(ctx, [{ doc, old_text: '', new_text: 'An entry' }])).rejects.toThrow(
        'operator_no_request',
      );
    },
  );
});

it('migrates old document writes without granting autonomous lessons authority', () => {
  const db = new Database(':memory:');
  try {
    const version = migrations.find((migration) => migration.name === 'autonomous lessons writes')!.version;
    for (const migration of migrations.filter((migration) => migration.version < version))
      db.exec(migration.sql);
    db.pragma(`user_version = ${version - 1}`);
    db.exec(`INSERT INTO doc_writes (id, project_key, repo, base, base_commit, edits, message, author,
      engine_id, state, created_at, updated_at)
      VALUES ('dw_old', 'AR', 'repo', 'main', '${BASE}', '[]', 'Old write', 'operator',
        'local', 'queued', '2026-01-01', '2026-01-01');`);
    migrate(db);
    expect(createRepositories(db).docWrites.get('dw_old')).toMatchObject({
      autonomousLessons: false,
      externalOrigin: null,
      requestId: null,
    });
  } finally {
    db.close();
  }
});

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
  it.each([false, true])(
    'notifies publication once after commit, including a local checkout warning (%s)',
    async (warning) => {
      const merger = (await setup())!;
      const { requestId } = await ownerAsks();
      await h.domain.docWrites.stop();
      if (warning)
        merger.advance.mockResolvedValue({
          ok: false,
          reason: 'checkout_in_the_way',
          paths: [],
          message: 'busy',
        });
      let committed: unknown;
      const onPublished = vi.fn(() => {
        const row = h.repos.docWrites.list('published')[0]!;
        committed = {
          transaction: h.repos.db.inTransaction,
          commit: row.commitSha,
          status: stepsOf(requestId)[0]?.status,
        };
        throw new Error('notification failed');
      });
      const ctx = createDomainContext({
        repos: h.repos,
        bus: h.domain.bus,
        logger: h.log.logger,
        now: () => new Date(),
      });
      const writes = new DocWrites({
        ctx,
        projects: h.domain.projects,
        engines: {
          engineFor: () => 'local',
          get: () => ({ merger }) as unknown as EngineHost,
        } as unknown as EngineDirectory,
        messaging: h.domain.messaging,
        merges: { busy: () => false, holder: () => null, pump: () => {} },
        onPublished,
      });
      try {
        const result = await writes.request({
          projectKey: 'AR',
          author: 'operator',
          requestedBy: 'owner',
          requestId,
          baseCommit: BASE,
          message: 'Add decision',
          edits: [append('3. Third')],
        });
        expect(result).toMatchObject({
          state: 'published',
          ...(warning ? { warning: 'local_checkout' } : {}),
        });
        expect(onPublished).toHaveBeenCalledExactlyOnceWith({
          projectKey: 'AR',
          repo: 'web',
          base: 'main',
          commit: 'w1'.padEnd(40, '0'),
        });
        expect(committed).toEqual({ transaction: false, commit: 'w1'.padEnd(40, '0'), status: 'done' });
      } finally {
        await writes.stop();
        ctx.journal.stop();
      }
    },
  );

  it('publishes one commit with the trailers, pushes it and moves the local branch', async () => {
    const merger = (await setup())!;
    merger.isAncestor.mockResolvedValue(true);
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
    await vi.waitFor(async () => {
      const copy = await h.domain.history.search(
        'AR',
        { handle: 'owner', access: 'owner' },
        { query: 'Third', sourceTypes: ['document'] },
      );
      expect(copy.matches).toHaveLength(1);
      expect(copy.matches[0]?.document).toMatchObject({ path: DECISIONS, commit: 'w1'.padEnd(40, '0') });
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

  it('refuses a third document path before queueing a write or a step', async () => {
    const merger = (await setup())!;
    const { ctx, requestId } = await ownerAsks();
    expect(
      await refusal(
        write(ctx, [
          append('Third'),
          { doc: 'roadmap', old_text: '', new_text: 'Next' },
          { doc: 'lessons', old_text: '', new_text: 'Lesson' },
        ]),
      ),
    ).toContain('invalid_request:');
    expect(h.repos.docWrites.openOf('AR')).toBeNull();
    expect(stepsOf(requestId)).toMatchObject([{ status: 'refused' }]);
    expect(merger.commitFiles).not.toHaveBeenCalled();
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
        externalOrigin: null,
        autonomousLessons: false,
      });
      return { merger, requestId };
    }
    /** The restarted server finishes the left-over write in the background. */
    const publishedAfterRestart = () =>
      waitFor(() => h.repos.docWrites.get('dw_left')?.state === 'published', {
        what: 'the left-over write to be published',
      });
    async function repoName(): Promise<string> {
      return (await h.domain.projects.config('AR')).project.repos[0]!.name;
    }

    it('publishes a write whose commit is already on the remote, and advances the local branch', async () => {
      const { merger, requestId } = await leaveRunning('c'.repeat(40));
      merger.trees.set('c'.repeat(40), { [DECISIONS]: `${LOG}3. Third` });
      merger.state.remote = 'c'.repeat(40);
      merger.state.remoteHas.add('c'.repeat(40));
      h = await restartDomainHarness(h, { merger });
      await publishedAfterRestart();
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
      const messages = await waitFor(
        () => {
          const sent = h.repos.messages.list('AR', { member: 'operator' }).filter((m) => m.from === 'system');
          return sent.length > 0 && sent;
        },
        { what: 'the message to the Operator about the published write' },
      );
      expect(messages).toMatchObject([{ kind: 'info', body: expect.stringContaining('c'.repeat(40)) }]);
    });

    it('queues a write again, and runs it, when its commit is not on the remote', async () => {
      const { merger } = await leaveRunning('c'.repeat(40));
      h = await restartDomainHarness(h, { merger });
      await publishedAfterRestart();
      expect(h.repos.docWrites.get('dw_left')).toMatchObject({
        state: 'published',
        commitSha: 'w1'.padEnd(40, '0'),
      });
      expect(merger.push).toHaveBeenCalledTimes(1);
    });

    it('runs a write that never got as far as a commit', async () => {
      const { merger } = await leaveRunning(null);
      h = await restartDomainHarness(h, { merger });
      await publishedAfterRestart();
      expect(h.repos.docWrites.get('dw_left')).toMatchObject({ state: 'published' });
    });
  });
});

describe('autonomous lessons (PM-1004)', () => {
  const lesson = (old_text = '', new_text = '# Lessons\n') => ({
    doc: 'lessons' as const,
    old_text,
    new_text,
  });
  async function internal() {
    const { ctx, requestId } = await ownerAsks();
    h.repos.operatorRequests.close(requestId, new Date().toISOString());
    return ctx;
  }
  async function fromQueue(from: 'system' | 'dev-1') {
    if (from === 'system') {
      await h.domain.inbox.openIntegratorTodo({
        projectKey: 'AR',
        taskKey: null,
        askedBy: 'system',
        question: 'Record the lesson',
        todo: { what: 'Record a lesson', where: 'Project documents', expected: 'A recorded lesson' },
      });
    } else {
      await h.domain.messaging.send(
        'AR',
        from,
        { to: ['operator'], text: 'Record the lesson' },
        { kind: 'action' },
      );
    }
    const item = await waitFor(
      () => h.repos.memberQueue.listOpen('AR', 'operator').find((item) => item.state === 'processing'),
      { what: 'the processing Operator queue item' },
    );
    const request = await waitFor(() => h.repos.operatorRequests.openOfSession(item.sessionId!)[0], {
      what: 'the open Operator request of the queue item',
    });
    expect(request).toMatchObject({
      source: 'queue',
      queueItemId: item.id,
      fromHandle: from,
    });
    return { ctx: toolOf(await ownerConversation()), item };
  }

  it('reads and creates missing lessons without an owner request or owner attribution', async () => {
    const merger = (await setup())!;
    const ctx = await internal();
    const read = await h.domain.teamTools.readProjectDoc(ctx, { doc: 'lessons' });
    expect(read).toMatchObject({ path: LESSONS, commit: BASE, exists: false });
    const result = await write(ctx, [lesson()], read.commit);
    expect(result).toMatchObject({ state: 'published', paths: [LESSONS] });
    expect(h.repos.docWrites.get(result.write_id)).toMatchObject({
      autonomousLessons: true,
      externalOrigin: null,
      requestedBy: null,
      requestId: null,
      stepId: null,
    });
    expect(merger.commitFiles.mock.calls[0]![1].message.split('\n')).toEqual([
      'Add decision 3',
      '',
      'Projectman-Operator: operator',
      'Projectman-Operator-Mode: autonomous-lessons',
    ]);
  });

  it('rewrites existing lessons rather than requiring append-only text', async () => {
    const merger = (await setup(fakeDocsMerger({ [LESSONS]: '# Lessons\nOld lesson\n' })))!;
    const ctx = await internal();
    expect(await write(ctx, [lesson('Old lesson', 'New lesson')])).toMatchObject({ state: 'published' });
    expect(merger.trees.get(merger.state.remote)![LESSONS]).toBe('# Lessons\nNew lesson\n');
  });

  it('requires an explicitly configured lessons path', async () => {
    await setup(fakeDocsMerger(), { docs: false });
    const ctx = await internal();
    expect(await refusal(write(ctx, [lesson()]))).toMatch(/^docs_not_configured:/);
  });

  it.each(['system', 'dev-1'] as const)(
    'reads and writes lessons from a real %s queue request',
    async (from) => {
      await setup();
      const { ctx } = await fromQueue(from);
      const read = await h.domain.teamTools.readProjectDoc(ctx, { doc: 'lessons' });
      expect(await write(ctx, [lesson()], read.commit)).toMatchObject({ state: 'published' });
    },
  );

  it.each(['session', 'project', 'member', 'state', 'missing'] as const)(
    'rejects a queue request with an invalid %s binding for reads and writes',
    async (binding) => {
      const merger = (await setup())!;
      const { ctx, item } = await fromQueue('system');
      const request = h.repos.operatorRequests.openOfSession(ctx.sessionId)[0]!;
      if (binding === 'missing') {
        h.repos.db.prepare('UPDATE operator_requests SET queue_item_id = NULL WHERE id = ?').run(request.id);
      } else {
        const column = { session: 'session_id', project: 'project_key', member: 'member', state: 'state' }[
          binding
        ];
        const value = binding === 'state' ? 'queued' : binding === 'project' ? 'OTHER' : 'other';
        if (binding === 'project') {
          h.repos.db
            .prepare(
              "INSERT INTO projects (key, name, template_id, config_version, created_at, updated_at) VALUES ('OTHER', 'Other', NULL, 'v1', '2026-01-01', '2026-01-01')",
            )
            .run();
          h.repos.db
            .prepare('UPDATE member_queue_items SET project_key = ? WHERE id = ?')
            .run(value, item.id);
        } else
          h.repos.db.prepare(`UPDATE member_queue_items SET ${column} = ? WHERE id = ?`).run(value, item.id);
      }
      expect(await refusal(h.domain.teamTools.readProjectDoc(ctx, { doc: 'lessons' }))).toMatch(
        /^operator_owner_only:/,
      );
      expect(await refusal(write(ctx, [lesson()]))).toMatch(/^operator_owner_only:/);
      expect(merger.commitFiles).not.toHaveBeenCalled();
    },
  );

  it('keeps mixed and other documents behind the owner-request guard in the queue', async () => {
    await setup();
    const { ctx } = await fromQueue('dev-1');
    for (const edits of [
      [lesson(), append('Third')],
      [{ doc: 'roadmap' as const, old_text: '', new_text: 'Next' }],
    ])
      expect(await refusal(write(ctx, edits))).toMatch(/^operator_owner_only:/);
    expect(await refusal(h.domain.teamTools.readProjectDoc(ctx, { doc: 'decisions' }))).toMatch(
      /^operator_owner_only:/,
    );
    expect(h.repos.docWrites.openOf('AR')).toBeNull();
  });

  it('keeps mixed edits behind the owner-request guard with no request', async () => {
    await setup();
    const ctx = await internal();
    expect(await refusal(write(ctx, [lesson(), append('Third')]))).toMatch(/^operator_no_request:/);
  });

  it('refuses lessons in a guest conversation', async () => {
    await setup();
    await say('cleo');
    const guest = operatorSessions().find(
      (s) => s.workItem.type === 'general' && s.workItem.with === 'cleo',
    )!;
    const ctx = toolOf(guest);
    expect(await refusal(h.domain.teamTools.readProjectDoc(ctx, { doc: 'lessons' }))).toMatch(
      /^operator_owner_only:/,
    );
    expect(await refusal(write(ctx, [lesson()]))).toMatch(/^operator_owner_only:/);
  });

  it.each(['approval', 'message', 'answer'] as const)(
    'refuses a non-owner %s request in the internal conversation',
    async (source) => {
      await setup();
      const ctx = await internal();
      h.repos.operatorRequests.insert({
        id: 'opr_disallowed',
        projectKey: 'AR',
        sessionId: ctx.sessionId,
        source,
        messageId: null,
        inboxItemId: null,
        queueItemId: null,
        fromHandle: source === 'approval' ? 'owner' : 'dev-1',
        quote: 'Record lessons',
        openedAt: new Date().toISOString(),
      });
      const code = source === 'approval' ? /^operator_no_request:/ : /^operator_owner_only:/;
      expect(await refusal(h.domain.teamTools.readProjectDoc(ctx, { doc: 'lessons' }))).toMatch(code);
      expect(await refusal(write(ctx, [lesson()]))).toMatch(code);
    },
  );

  it('rejects a context that does not identify the Operator session', async () => {
    await setup();
    const ctx = { ...(await internal()), sessionId: 'unknown' };
    expect(await refusal(write(ctx, [lesson()]))).toMatch(/^operator_owner_only:/);
  });

  it('continues a delayed lessons write after a restart and sends its result without an owner step', async () => {
    const merger = (await setup(fakeDocsMerger(), { persistent: true }))!;
    const ctx = await internal();
    vi.spyOn(h.domain.merges, 'busy').mockReturnValue(true);
    const queued = await write(ctx, [lesson()]);
    expect(queued.state).toBe('queued');
    h = await restartDomainHarness(h, { merger });
    await settle();
    expect(h.repos.docWrites.get(queued.write_id)).toMatchObject({ state: 'published', stepId: null });
    const messages = h.repos.messages.list('AR', { member: 'operator' }).filter((m) => m.from === 'system');
    expect(messages).toMatchObject([{ kind: 'info', body: expect.stringContaining(queued.write_id) }]);
  });

  it.each([false, true])(
    'reauthorizes a running autonomous write after restart (reconfigured: %s)',
    async (reconfigured) => {
      const merger = (await setup(fakeDocsMerger(), { persistent: true }))!;
      const ctx = await internal();
      vi.spyOn(h.domain.merges, 'busy').mockReturnValue(true);
      const queued = await write(ctx, [lesson()]);
      const commit = 'c'.repeat(40);
      merger.state.remote = commit;
      merger.state.remoteHas.add(commit);
      merger.trees.set(commit, { [LESSONS]: '# Lessons\n' });
      h.repos.docWrites.update(queued.write_id, {
        state: 'running',
        commitSha: commit,
        updatedAt: new Date().toISOString(),
      });
      if (reconfigured)
        await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
          config.project.repos[0]!.docs!.lessons = 'docs/MOVED.md';
          return 'Move lessons';
        });
      h = await restartDomainHarness(h, { merger });
      await settle();
      if (reconfigured) {
        expect(h.repos.docWrites.get(queued.write_id)).toMatchObject({
          state: 'failed',
          error: { code: 'authorization_revoked' },
        });
        expect(merger.advance).not.toHaveBeenCalled();
      } else {
        expect(h.repos.docWrites.get(queued.write_id)).toMatchObject({
          state: 'published',
          commitSha: commit,
        });
        expect(merger.advance).toHaveBeenCalledWith(expect.anything(), {
          base: 'main',
          from: BASE,
          to: commit,
        });
      }
      expect(merger.push).not.toHaveBeenCalled();
    },
  );

  it.each(['mixed', 'empty', 'author'] as const)(
    'enforces the lessons-only service entry against %s input',
    async (invalid) => {
      await setup();
      const input = {
        projectKey: 'AR',
        author: invalid === 'author' ? 'dev-1' : 'operator',
        baseCommit: BASE,
        message: 'Record lesson',
        edits: invalid === 'empty' ? [] : invalid === 'mixed' ? [lesson(), append('Third')] : [lesson()],
      };
      await expect(h.domain.docWrites.requestLessons(input)).rejects.toMatchObject({
        code: invalid === 'author' ? 'operator_only' : 'operator_owner_only',
      });
      expect(h.repos.docWrites.openOf('AR')).toBeNull();
    },
  );

  it.each(['lessons', 'repo', 'base', 'operator'] as const)(
    'revokes a queued write when its %s authorization changes',
    async (change) => {
      const merger = (await setup())!;
      const ctx = await internal();
      const busy = vi.spyOn(h.domain.merges, 'busy').mockReturnValue(true);
      const queued = await write(ctx, [lesson()]);
      const config = structuredClone(await h.domain.projects.config('AR'));
      if (change === 'operator')
        config.team.members = config.team.members.filter((m) => m.handle !== 'operator');
      else if (change === 'lessons') delete config.project.repos[0]!.docs!.lessons;
      else if (change === 'repo') config.project.repos[0]!.name = 'other';
      else config.project.repos[0]!.defaultBranch = 'other';
      vi.spyOn(h.domain.projects, 'config').mockResolvedValue(config);
      busy.mockReturnValue(false);
      h.domain.docWrites.pump();
      await settle();
      expect(h.repos.docWrites.get(queued.write_id)).toMatchObject({
        state: 'failed',
        error: { code: 'authorization_revoked' },
      });
      expect(merger.commitFiles).not.toHaveBeenCalled();
      expect(merger.push).not.toHaveBeenCalled();
    },
  );

  it.each([
    { change: 'lessons', remote: true },
    { change: 'operator', remote: true },
    { change: 'lessons', remote: false },
  ])('rechecks $change immediately before publication (remote: $remote)', async ({ change, remote }) => {
    const merger = (await setup())!;
    const ctx = await internal();
    if (!remote)
      merger.prepare.mockResolvedValue({
        local: BASE,
        remote: null,
        relation: 'same',
        contains: { local: true, remote: null },
        checkout: null,
      });
    merger.checkoutConflicts.mockImplementationOnce(async () => {
      const config = structuredClone(await h.domain.projects.config('AR'));
      if (change === 'operator')
        config.team.members = config.team.members.filter((m) => m.handle !== 'operator');
      else config.project.repos[0]!.docs!.lessons = 'other.md';
      vi.spyOn(h.domain.projects, 'config').mockResolvedValue(config);
      return [];
    });
    expect(await refusal(write(ctx, [lesson()]))).toContain('authorization_revoked');
    expect(merger.push).not.toHaveBeenCalled();
    expect(merger.advance).not.toHaveBeenCalled();
  });

  it('rejects an autonomous marker combined with an owner request after restart', async () => {
    const merger = (await setup(fakeDocsMerger(), { persistent: true }))!;
    const { ctx, requestId } = await ownerAsks();
    vi.spyOn(h.domain.merges, 'busy').mockReturnValue(true);
    const queued = await write(ctx, [lesson()]);
    h.repos.db
      .prepare('UPDATE doc_writes SET request_id = ?, state = ?, commit_sha = ? WHERE id = ?')
      .run(requestId, 'running', BASE, queued.write_id);
    h = await restartDomainHarness(h, { merger });
    await settle();
    expect(h.repos.docWrites.get(queued.write_id)).toMatchObject({
      state: 'failed',
      error: { code: 'authorization_revoked' },
    });
    expect(merger.advance).not.toHaveBeenCalled();
  });

  it('reports stale lessons with a retry instead of requesting owner approval', async () => {
    const merger = (await setup())!;
    const ctx = await internal();
    const busy = vi.spyOn(h.domain.merges, 'busy').mockReturnValue(true);
    const queued = await write(ctx, [lesson()]);
    merger.state.remote = 'e'.repeat(40);
    merger.trees.set(merger.state.remote, { [LESSONS]: 'Changed' });
    busy.mockReturnValue(false);
    h.domain.docWrites.pump();
    await settle();
    expect(h.repos.docWrites.get(queued.write_id)?.state).toBe('stale');
    const message = h.repos.messages.list('AR', { member: 'operator' }).find((m) => m.from === 'system')!;
    expect(message.body).toContain('retry');
    expect(message.body).not.toContain('owner');
  });
});

describe('write_project_docs through the bearer MCP (PM-784)', () => {
  const OWNER_USER = 'usr_owner';
  const KEY = { id: 'ikey_one', prefix: 'pmi_abcdefgh' };
  const stops: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
  });

  /** A live scope of a key, as the authenticated facade makes it; the checks of membership are the facade's own. */
  async function scope(mode: 'super' | 'read' = 'super', userId = OWNER_USER) {
    const config = await h.domain.projects.config('AR');
    const actor = superActorOf(config, KEY)!;
    return {
      active: true,
      context: {
        principal: { kind: 'integrator' as const, userId, keyId: KEY.id, prefix: KEY.prefix, mode },
        projectKey: 'AR',
        actor,
        requestId: 'req-ext-1',
      },
      actorFor: () => actor,
      assertAccess: () => undefined,
      assertMutation: () => {},
      authorizeMutation: async () => {},
    } satisfies IntegratorExecutionScope;
  }

  /** The service with an external runner whose `assertActive` the test controls. */
  function externalWrites(
    merger: ReturnType<typeof fakeDocsMerger>,
    runner: DocWriteExternalRunner | null,
    externalWaitMs = 2000,
  ) {
    const ctx = createDomainContext({
      repos: h.repos,
      bus: h.domain.bus,
      logger: h.log.logger,
      now: () => new Date(),
    });
    const writes = new DocWrites({
      ctx,
      projects: h.domain.projects,
      engines: {
        engineFor: () => 'local',
        get: () => ({ merger }) as unknown as EngineHost,
      } as unknown as EngineDirectory,
      messaging: h.domain.messaging,
      merges: { busy: () => false, holder: () => null, pump: () => {} },
      ...(runner ? { external: runner } : {}),
      externalWaitMs,
    });
    stops.push(async () => {
      await writes.stop();
      ctx.journal.stop();
    });
    return writes;
  }
  const request = (
    writes: DocWrites,
    s: IntegratorExecutionScope,
    base = BASE,
    text = '3. Third',
    doc: ProjectDoc = 'decisions',
  ) =>
    runIntegratorExecution(s, () =>
      writes.requestExternal({
        projectKey: 'AR',
        baseCommit: base,
        message: 'Add decision 3',
        edits: [{ doc, old_text: '', new_text: text }],
      }),
    );
  const allowing: DocWriteExternalRunner = { run: async (_key, _origin, action) => action(async () => {}) };

  it('publishes with the key’s trailers, and the same owner reads the write back', async () => {
    const merger = (await setup())!;
    const writes = externalWrites(merger, allowing);
    const outcome = await request(writes, await scope());
    expect(outcome).toMatchObject({ state: 'published', commit: 'w1'.padEnd(40, '0'), paths: [DECISIONS] });
    const input = merger.commitFiles.mock.calls[0]![1];
    expect(input.message).toBe(
      [
        'Add decision 3',
        '',
        'Projectman-Operator: operator',
        'Projectman-Operator-Mode: super',
        'Projectman-Via: integrator',
        `Projectman-Credential-Id: ${KEY.id}`,
        `Projectman-Credential-Prefix: ${KEY.prefix}`,
        'Projectman-External-Request: req-ext-1',
      ].join('\n'),
    );
    const id = (outcome as { id: string }).id;
    expect(h.repos.docWrites.get(id)).toMatchObject({
      state: 'published',
      author: 'operator',
      requestedBy: null,
      requestId: null,
      externalOrigin: { ownerUserId: OWNER_USER, requestId: 'req-ext-1' },
    });
    // The same owner reads it in the read mode as well; another owner and a missing id are not_found.
    expect(
      await runIntegratorExecution(await scope('read'), () => writes.externalState('AR', id)),
    ).toMatchObject({
      write_id: id,
      state: 'published',
      commit: 'w1'.padEnd(40, '0'),
      failure: null,
    });
    await expect(
      runIntegratorExecution(await scope('read', 'usr_other'), () => writes.externalState('AR', id)),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      runIntegratorExecution(await scope('read'), () => writes.externalState('AR', 'dw_missing')),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses an autonomous marker on an external write instead of bypassing key authorization', async () => {
    const merger = (await setup())!;
    const writes = externalWrites(merger, allowing);
    const outcome = await request(writes, await scope(), BASE, 'A lesson', 'lessons');
    expect(outcome.state).toBe('published');
    merger.push.mockClear();
    h.repos.db
      .prepare("UPDATE doc_writes SET autonomous_lessons = 1, state = 'queued' WHERE id = ?")
      .run(outcome.id);
    writes.pump();
    await settle();
    expect(h.repos.docWrites.get(outcome.id)).toMatchObject({
      state: 'failed',
      error: { code: 'authorization_revoked' },
    });
    expect(merger.push).not.toHaveBeenCalled();
  });

  it('keeps the decision log append-only and a stale base out, before anything is queued', async () => {
    const merger = (await setup())!;
    const writes = externalWrites(merger, allowing);
    await expect(
      runIntegratorExecution(await scope(), () =>
        writes.requestExternal({
          projectKey: 'AR',
          baseCommit: BASE,
          message: 'Rewrite',
          edits: [{ doc: 'decisions', old_text: '1. First', new_text: '1. Changed' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'docs_not_append_only' });
    await expect(request(writes, await scope(), 'f'.repeat(40))).rejects.toThrow(
      /unknown commit|readable|read/i,
    );
    expect(h.repos.docWrites.list('queued')).toEqual([]);
    expect(merger.commitFiles).not.toHaveBeenCalled();
  });

  it('refuses a read key and a build without the runner', async () => {
    const merger = (await setup())!;
    const writes = externalWrites(merger, allowing);
    await expect(request(writes, await scope('read'))).rejects.toMatchObject({
      code: 'integrator_read_only',
    });
    const without = externalWrites(merger, null);
    await expect(request(without, await scope())).rejects.toMatchObject({ code: 'integrator_not_allowed' });
    // A call outside any authenticated scope has no origin to write under.
    await expect(
      writes.requestExternal({ projectKey: 'AR', baseCommit: BASE, message: 'm', edits: [append('x')] }),
    ).rejects.toMatchObject({ code: 'insufficient_access' });
    expect(h.repos.docWrites.list('queued')).toEqual([]);
  });

  it('refuses a third document path through the external write entry before queueing', async () => {
    const merger = (await setup())!;
    const writes = externalWrites(merger, allowing);
    await expect(
      runIntegratorExecution(await scope(), () =>
        writes.requestExternal({
          projectKey: 'AR',
          baseCommit: BASE,
          message: 'Update documents',
          edits: ['decisions', 'roadmap', 'lessons'].map((doc) => ({
            doc: doc as ProjectDoc,
            old_text: '',
            new_text: 'New',
          })),
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request', status: 422 });
    expect(h.repos.docWrites.openOf('AR')).toBeNull();
    expect(merger.commitFiles).not.toHaveBeenCalled();
  });

  it('ends a queued write as authorization_revoked when the key is gone at its start, and pushes nothing', async () => {
    const merger = (await setup())!;
    const revoked: DocWriteExternalRunner = {
      run: async () => {
        throw new Error('the credential is gone');
      },
    };
    const writes = externalWrites(merger, revoked);
    const outcome = await request(writes, await scope(), BASE, 'A lesson', 'lessons');
    expect(outcome).toMatchObject({ state: 'failed', failure: 'authorization_revoked' });
    expect(merger.commitFiles).not.toHaveBeenCalled();
    expect(merger.push).not.toHaveBeenCalled();
    const id = (outcome as { id: string }).id;
    expect(
      await runIntegratorExecution(await scope('read'), () => writes.externalState('AR', id)),
    ).toMatchObject({
      state: 'failed',
      failure: 'authorization_revoked',
      commit: null,
    });
  });

  it('checks the authorization again before the push, and ends the write as revoked when it went', async () => {
    const merger = (await setup())!;
    let calls = 0;
    const revokedMidway: DocWriteExternalRunner = {
      run: async (_key, _origin, action) =>
        action(async () => {
          // The first check is at the start; the next ones come after the commit is built.
          if (++calls > 1) throw new Error('the key was revoked');
        }),
    };
    const writes = externalWrites(merger, revokedMidway);
    const outcome = await request(writes, await scope(), BASE, 'A lesson', 'lessons');
    expect(outcome).toMatchObject({ state: 'failed', failure: 'authorization_revoked' });
    expect(merger.push).not.toHaveBeenCalled();
    expect(merger.state.remote).toBe(BASE);
  });

  it('refuses a second write while one is open', async () => {
    const merger = (await setup())!;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow: DocWriteExternalRunner = {
      run: async (_key, _origin, action) => {
        await held;
        return action(async () => {});
      },
    };
    const writes = externalWrites(merger, slow, 20);
    const first = await request(writes, await scope());
    expect(first).toMatchObject({ state: 'running' });
    await expect(request(writes, await scope(), BASE, '4. Fourth')).rejects.toMatchObject({
      code: 'docs_write_pending',
    });
    release();
    await vi.waitFor(() =>
      expect(h.repos.docWrites.get((first as { id: string }).id)?.state).toBe('published'),
    );
  });

  it('leaves a write of the old kind (no origin, no request) as revoked after a restart', async () => {
    const merger = (await setup(fakeDocsMerger(), { persistent: true }))!;
    const now = new Date().toISOString();
    h.repos.docWrites.insert({
      id: 'dw_forged',
      projectKey: 'AR',
      repo: (await h.domain.projects.config('AR')).project.repos[0]!.name,
      base: 'main',
      baseCommit: BASE,
      edits: [{ path: DECISIONS, old_text: '', new_text: '3. Third' }],
      message: 'Forged\n\nProjectman-Operator: operator',
      author: 'operator',
      requestedBy: null,
      requestId: null,
      stepId: null,
      engineId: 'local',
      state: 'queued',
      commitSha: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      externalOrigin: null,
      autonomousLessons: false,
    });
    h = await restartDomainHarness(h, { merger });
    await settle();
    expect(h.repos.docWrites.get('dw_forged')).toMatchObject({
      state: 'failed',
      error: { code: 'authorization_revoked' },
    });
    expect(merger.push).not.toHaveBeenCalled();
  });
});
