import type { Release } from '@projectman/shared';
import type { Db } from './database';

interface ReleaseRow {
  id: string;
  project_key: string;
  repo: string;
  task_key: string;
  state: Release['state'];
  commit: string;
  base_commit: string | null;
  tasks_json: string;
  summary: string;
  proposed_by: string;
  proposed_at: string;
  decided_by: string | null;
  decided_at: string | null;
  deploy_started_at: string | null;
  previous_commit: string | null;
  live_at: string | null;
  tag: string | null;
  url: string | null;
  published_at: string | null;
  failure_json: string | null;
  publish_error: string | null;
}

const SELECT = `SELECT id, project_key, repo, task_key, state, "commit" AS "commit", base_commit, tasks_json, summary,
  proposed_by, proposed_at, decided_by, decided_at, deploy_started_at, previous_commit, live_at, tag, url,
  published_at, failure_json, publish_error FROM releases`;

function release(row: ReleaseRow): Release {
  return {
    id: row.id,
    projectKey: row.project_key,
    repo: row.repo,
    taskKey: row.task_key,
    state: row.state,
    commit: row.commit,
    baseCommit: row.base_commit,
    tasks: JSON.parse(row.tasks_json) as string[],
    summary: row.summary,
    proposedBy: row.proposed_by,
    proposedAt: row.proposed_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    deployStartedAt: row.deploy_started_at,
    previousCommit: row.previous_commit,
    liveAt: row.live_at,
    tag: row.tag,
    url: row.url,
    publishedAt: row.published_at,
    failure: row.failure_json ? (JSON.parse(row.failure_json) as Release['failure']) : null,
    publishError: row.publish_error,
  };
}

/** The releases of the instance itself (PM-491), as stored. */
export function createReleaseRepository(db: Db) {
  const read = (sql: string, ...args: string[]) =>
    (db.prepare(`${SELECT} ${sql}`).all(...args) as ReleaseRow[]).map(release);
  return {
    /** The newest published tag of this commit, across release targets. */
    tagOfCommit(commit: string): string | null {
      return (
        read(
          `WHERE "commit" = ? AND state = 'published' ORDER BY published_at DESC, rowid DESC LIMIT 1`,
          commit,
        )[0]?.tag ?? null
      );
    },
    get(id: string): Release | null {
      return read('WHERE id = ?', id)[0] ?? null;
    },
    /** The project's release that holds its one slot (proposed, approved or deploying). */
    open(projectKey: string): Release | null {
      return (
        read("WHERE project_key = ? AND state IN ('proposed','approved','deploying')", projectKey)[0] ?? null
      );
    },
    /** The project's releases, newest first. */
    list(projectKey: string): Release[] {
      return read('WHERE project_key = ? ORDER BY proposed_at DESC, rowid DESC', projectKey);
    },
    /** The latest release that went live (live or published): the base of the next one. */
    latestLive(projectKey: string): Release | null {
      return (
        read(
          "WHERE project_key = ? AND state IN ('live','published') ORDER BY live_at DESC, rowid DESC LIMIT 1",
          projectKey,
        )[0] ?? null
      );
    },
    /** The oldest release the watcher has something to do with: approved, deploying, or live and not yet published. */
    next(projectKey: string): Release | null {
      return (
        read(
          `WHERE project_key = ? AND (state IN ('approved','deploying') OR (state = 'live' AND published_at IS NULL))
           ORDER BY proposed_at, rowid LIMIT 1`,
          projectKey,
        )[0] ?? null
      );
    },
    /** The tags of the releases that have one. */
    tags(projectKey: string): string[] {
      return (
        db.prepare('SELECT tag FROM releases WHERE project_key = ? AND tag IS NOT NULL').all(projectKey) as {
          tag: string;
        }[]
      ).map((row) => row.tag);
    },
    insert(value: Release, updatedAt: string): void {
      db.prepare(
        `INSERT INTO releases (id, project_key, repo, task_key, state, "commit", base_commit, tasks_json, summary,
          proposed_by, proposed_at, decided_by, decided_at, deploy_started_at, previous_commit, live_at, tag, url,
          published_at, failure_json, publish_error, updated_at)
         VALUES (@id, @projectKey, @repo, @taskKey, @state, @commit, @baseCommit, @tasksJson, @summary,
          @proposedBy, @proposedAt, @decidedBy, @decidedAt, @deployStartedAt, @previousCommit, @liveAt, @tag, @url,
          @publishedAt, @failureJson, @publishError, @updatedAt)`,
      ).run({
        ...value,
        tasksJson: JSON.stringify(value.tasks),
        failureJson: value.failure ? JSON.stringify(value.failure) : null,
        updatedAt,
      });
    },
    save(value: Release, updatedAt: string): void {
      db.prepare(
        `UPDATE releases SET state = @state, decided_by = @decidedBy, decided_at = @decidedAt,
          deploy_started_at = @deployStartedAt, previous_commit = @previousCommit, live_at = @liveAt,
          tag = @tag, url = @url, published_at = @publishedAt, failure_json = @failureJson,
          publish_error = @publishError, updated_at = @updatedAt WHERE id = @id`,
      ).run({
        ...value,
        failureJson: value.failure ? JSON.stringify(value.failure) : null,
        updatedAt,
      });
    },
  };
}
