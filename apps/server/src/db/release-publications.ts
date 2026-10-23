import type { Db } from './database';

/** The tag and GitHub release of one merged commit (`publish_release`, PM-968). `url` null: the release is not made yet. */
export interface ReleasePublication {
  id: string;
  projectKey: string;
  repo: string;
  commit: string;
  baseCommit: string | null;
  tag: string;
  tasks: string[];
  summary: string;
  publishedBy: string;
  taggedAt: string;
  url: string | null;
  publishedAt: string | null;
}

interface PublicationRow {
  id: string;
  project_key: string;
  repo: string;
  commit: string;
  base_commit: string | null;
  tag: string;
  tasks_json: string;
  summary: string;
  published_by: string;
  tagged_at: string;
  url: string | null;
  published_at: string | null;
}

const SELECT = `SELECT id, project_key, repo, "commit" AS "commit", base_commit, tag, tasks_json, summary,
  published_by, tagged_at, url, published_at FROM release_publications`;

function publication(row: PublicationRow): ReleasePublication {
  return {
    id: row.id,
    projectKey: row.project_key,
    repo: row.repo,
    commit: row.commit,
    baseCommit: row.base_commit,
    tag: row.tag,
    tasks: JSON.parse(row.tasks_json) as string[],
    summary: row.summary,
    publishedBy: row.published_by,
    taggedAt: row.tagged_at,
    url: row.url,
    publishedAt: row.published_at,
  };
}

export function createReleasePublicationRepository(db: Db) {
  return {
    byCommit(projectKey: string, repo: string, commit: string): ReleasePublication | null {
      const row = db
        .prepare(`${SELECT} WHERE project_key = ? AND repo = ? AND "commit" = ?`)
        .get(projectKey, repo, commit) as PublicationRow | undefined;
      return row ? publication(row) : null;
    },
    byTag(projectKey: string, repo: string, tag: string): ReleasePublication | null {
      const row = db
        .prepare(`${SELECT} WHERE project_key = ? AND repo = ? AND tag = ?`)
        .get(projectKey, repo, tag) as PublicationRow | undefined;
      return row ? publication(row) : null;
    },
    /** The newest publication whose GitHub release exists. */
    latestPublished(projectKey: string, repo: string): ReleasePublication | null {
      const row = db
        .prepare(
          `${SELECT} WHERE project_key = ? AND repo = ? AND url IS NOT NULL
           ORDER BY published_at DESC, rowid DESC LIMIT 1`,
        )
        .get(projectKey, repo) as PublicationRow | undefined;
      return row ? publication(row) : null;
    },
    /** The tag of a commit whose GitHub release exists; null when it was not published. */
    tagOfCommit(commit: string): string | null {
      const row = db
        .prepare(
          `SELECT tag FROM release_publications WHERE "commit" = ? AND url IS NOT NULL
           ORDER BY published_at DESC, rowid DESC LIMIT 1`,
        )
        .get(commit) as { tag: string } | undefined;
      return row?.tag ?? null;
    },
    insert(value: ReleasePublication): void {
      db.prepare(
        `INSERT INTO release_publications (id, project_key, repo, "commit", base_commit, tag, tasks_json, summary,
           published_by, tagged_at, url, published_at)
         VALUES (@id, @projectKey, @repo, @commit, @baseCommit, @tag, @tasksJson, @summary,
           @publishedBy, @taggedAt, @url, @publishedAt)`,
      ).run({
        id: value.id,
        projectKey: value.projectKey,
        repo: value.repo,
        commit: value.commit,
        baseCommit: value.baseCommit,
        tag: value.tag,
        tasksJson: JSON.stringify(value.tasks),
        summary: value.summary,
        publishedBy: value.publishedBy,
        taggedAt: value.taggedAt,
        url: value.url,
        publishedAt: value.publishedAt,
      });
    },
    markPublished(id: string, url: string, at: string): void {
      db.prepare('UPDATE release_publications SET url = ?, published_at = ? WHERE id = ?').run(url, at, id);
    },
  };
}
