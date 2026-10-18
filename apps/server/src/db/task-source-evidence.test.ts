import { afterEach, describe, expect, it } from 'vitest';
import { createDomainHarness, OWNER_ACTOR } from '../../test/helpers/domain-harness';
import type { DomainHarness } from '../../test/helpers/domain-harness';

const AT = '2026-10-14T10:00:00.000Z';

describe('task source evidence (PM-797)', () => {
  let h: DomainHarness | undefined;
  let events = 0;
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });

  async function setup() {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Collecting card' }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Other card' }, OWNER_ACTOR);
  }
  const evidence = (key = 'AR-1') => h!.repos.tasks.sourceEvidence('AR', key);
  const sql = (text: string, ...params: unknown[]) => h!.repos.db.prepare(text).run(...params);
  const idOf = (key = 'AR-1') => h!.domain.tasks.get('AR', key).id;
  const event = (type: string, data: unknown, key = 'AR-1') =>
    sql(
      `INSERT INTO timeline_events (id, project_key, task_key, actor_kind, actor_handle, type, data, created_at)
       VALUES (?, 'AR', ?, 'system', NULL, ?, ?, ?)`,
      `evt_source${(events += 1)}`,
      key,
      type,
      typeof data === 'string' ? data : JSON.stringify(data),
      AT,
    );
  const session = (branch: string | null, reviewedCommit: string | null, key = 'AR-1') =>
    sql(
      `INSERT INTO sessions (id, project_key, member, work_item_type, work_item_ref, claude_session_id, cwd,
         branch, state, started_at, last_activity_at, reviewed_commit)
       VALUES (?, 'AR', 'dev-1', 'task', ?, 'claude-1', '/work', ?, 'ended', ?, ?, ?)`,
      `ses_source${(events += 1)}`,
      key,
      branch,
      AT,
      AT,
      reviewedCommit,
    );

  const traces: Array<[string, () => void]> = [
    ['a branch link', () => h!.repos.tasks.upsertLink(idOf(), { kind: 'branch', ref: 'task/AR-1' }, AT)],
    [
      'a pull request link',
      () => h!.repos.tasks.upsertLink(idOf(), { kind: 'pull_request', ref: '7', repo: 'acme/web' }, AT),
    ],
    [
      'a review pin',
      () =>
        sql(
          `INSERT INTO task_review_pins (project_key, task_key, stage_id, commit_id, branch, pinned_at, pinned_by)
           VALUES ('AR', 'AR-1', 'code_review', 'abc', 'task/AR-1', ?, 'dev-1')`,
          AT,
        ),
    ],
    [
      'a hand-over',
      () =>
        h!.repos.taskHandovers.save({
          projectKey: 'AR',
          taskKey: 'AR-1',
          commit: 'abc',
          branch: 'task/AR-1',
          stageId: 'code_review',
          at: AT,
        }),
    ],
    [
      'a workspace binding',
      () => {
        sql(
          `INSERT INTO member_workspaces (id, project_key, member, repo, path, generation, created_at)
           VALUES ('ws_1', 'AR', 'dev-1', 'web', '/work/ws', 1, ?)`,
          AT,
        );
        sql(
          `INSERT INTO task_workspace_bindings (project_key, task_key, member, workspace_id, kind, generation, created_at, updated_at)
           VALUES ('AR', 'AR-1', 'dev-1', 'ws_1', 'work', 1, ?, ?)`,
          AT,
          AT,
        );
      },
    ],
    ['an old session with a branch and no binding', () => session('task/AR-1', null)],
    ['a session that reviewed a commit', () => session(null, 'abc')],
    [
      'a merge record of any state',
      () =>
        sql(
          `INSERT INTO task_merges (id, project_key, task_key, repo, base, from_stage_id, to_stage_id, merger,
             requested_at, state, landed, created_at, updated_at)
           VALUES ('merge_1', 'AR', 'AR-1', 'web', 'main', 'code_review', 'done', 'dev-1', ?, 'cancelled', 'nowhere', ?, ?)`,
          AT,
          AT,
          AT,
        ),
    ],
    ['a branch link in the history', () => event('task_link_added', { kind: 'branch', ref: 'task/AR-1' })],
    [
      'a pull request link in the history',
      () => event('task_link_added', { kind: 'pull_request', ref: '7', repo: 'acme/web' }),
    ],
    [
      'a review pin on a stage change in the history',
      () =>
        event('task_stage_changed', {
          from: 'development',
          to: 'code_review',
          reviewPin: { commit: 'a', branch: 'b' },
        }),
    ],
    [
      'a moved branch on a stage change in the history',
      () =>
        event('task_stage_changed', {
          from: 'code_review',
          to: 'development',
          branchMoved: { branch: 'b', pinned: 'a', head: 'c' },
        }),
    ],
    [
      'a review pin update in the history',
      () =>
        event('task_updated', {
          fields: ['reviewPin'],
          reviewPin: { commit: 'a', branch: 'b', previous: 'c' },
        }),
    ],
    ['a merge in the history', () => event('task_merged', { repo: 'web' })],
  ];

  it('proves nothing was ever there for a native card nobody worked on', async () => {
    await setup();
    expect(evidence()).toEqual({ sourceRecorded: false, workRecorded: false, origin: 'native' });
  });

  it('knows no card of another project or a missing card', async () => {
    await setup();
    expect(evidence('AR-99')).toBeNull();
    expect(h!.repos.tasks.sourceEvidence('ZZ', 'AR-1')).toBeNull();
  });

  it.each(traces)('records a source for %s', async (_name, add) => {
    await setup();
    add();
    expect(evidence()).toMatchObject({ sourceRecorded: true });
    expect(evidence('AR-2')).toMatchObject({ sourceRecorded: false });
  });

  it('does not count a link of another kind, a session without a branch or the other card’s trace', async () => {
    await setup();
    h!.repos.tasks.upsertLink(idOf(), { kind: 'issue', ref: '12', repo: 'acme/web' }, AT);
    event('task_link_added', { kind: 'issue', ref: '12' });
    event('task_stage_changed', { from: 'backlog', to: 'development' });
    event('task_updated', { fields: ['title'] });
    session(null, null);
    session('task/AR-2', 'abc', 'AR-2');
    expect(evidence()).toMatchObject({ sourceRecorded: false });
  });

  it('records work for an assignee now or at any time before', async () => {
    await setup();
    sql('UPDATE tasks SET assignee = ? WHERE id = ?', 'dev-1', idOf());
    expect(evidence()).toMatchObject({ workRecorded: true });
    sql('UPDATE tasks SET assignee = NULL WHERE id = ?', idOf());
    expect(evidence()).toMatchObject({ workRecorded: false });
    event('task_assigned', { assignee: null });
    expect(evidence()).toMatchObject({ workRecorded: false });
    event('task_assigned', { assignee: 'dev-1' });
    expect(evidence()).toMatchObject({ workRecorded: true });
  });

  it.each([
    ['previous', { assignee: null, previous: 'dev-1' }],
    ['from', { assignee: null, from: 'dev-1', reason: 'handover' }],
  ])('records work for a card handed back through `%s`', async (_name, data) => {
    await setup();
    event('task_assigned', data);
    expect(evidence()).toMatchObject({ workRecorded: true });
  });

  it('reads the origin from exactly one well-formed creation event', async () => {
    await setup();
    await h!.domain.tasks.create('AR', { title: 'Imported', importedAt: AT }, OWNER_ACTOR);
    expect(evidence('AR-3')?.origin).toBe('imported');
    expect(evidence('AR-1')?.origin).toBe('native');
    sql(
      `UPDATE timeline_events SET data = '{"title":"x","imported":false}' WHERE task_key = 'AR-1' AND type = 'task_created'`,
    );
    expect(evidence('AR-1')?.origin).toBe('native');
    sql(
      `UPDATE timeline_events SET data = '{"title":"x","imported":"yes"}' WHERE task_key = 'AR-1' AND type = 'task_created'`,
    );
    expect(evidence('AR-1')?.origin).toBe('unknown');
    sql(`UPDATE timeline_events SET data = 'not json' WHERE task_key = 'AR-1' AND type = 'task_created'`);
    expect(evidence('AR-1')?.origin).toBe('unknown');
    sql(`UPDATE timeline_events SET data = '[]' WHERE task_key = 'AR-2' AND type = 'task_created'`);
    expect(evidence('AR-2')?.origin).toBe('unknown');
  });

  it('does not know the origin without a creation event or with two of them', async () => {
    await setup();
    sql(`DELETE FROM timeline_events WHERE task_key = 'AR-1' AND type = 'task_created'`);
    expect(evidence()?.origin).toBe('unknown');
    event('task_created', { title: 'again' });
    expect(evidence()?.origin).toBe('native');
    event('task_created', { title: 'twice' });
    expect(evidence()?.origin).toBe('unknown');
  });

  it('passes a database error on instead of an empty evidence', async () => {
    await setup();
    sql('DROP TABLE task_handovers');
    expect(() => evidence()).toThrow();
  });
});
