import { mergeTokenUsage, type TokenUsage } from '@projectman/shared';
import type { Db } from './database';
import { tokenUsageOf, type UsageRow } from './sessions';

/** Where a session's usage is counted: its member and, for a task's session, the task. */
export interface UsageOwner {
  sessionId: string;
  projectKey: string;
  member: string;
  taskKey: string | null;
}

/**
 * The tokens AI sessions used (PM-178), per session, hour, model and scope. A session's own sum
 * comes with the session (sessions repository); this adds to it and sums a member's time windows.
 */
export function createTokenUsageRepository(db: Db) {
  const upsert = db.prepare(
    `INSERT INTO token_usage (session_id, project_key, member, task_key, hour, model, scope,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, hour, model, scope) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`,
  );
  const byMember = db.prepare(
    `SELECT model, scope, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
       SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write
     FROM token_usage WHERE project_key = ? AND member = ? AND hour >= ? GROUP BY model, scope`,
  );
  const add = db.transaction((owner: UsageOwner, hour: string, entries: readonly TokenUsage[]) => {
    for (const e of entries) {
      upsert.run(
        owner.sessionId,
        owner.projectKey,
        owner.member,
        owner.taskKey,
        hour,
        e.model,
        e.scope,
        e.input,
        e.output,
        e.cacheRead,
        e.cacheWrite,
      );
    }
  });

  return {
    /** Adds usage increments of a session to the hour they were reported in. */
    add(owner: UsageOwner, at: Date, entries: readonly TokenUsage[]): void {
      if (entries.length > 0) add(owner, usageHour(at), entries);
    },
    /** What a member's sessions used from the hour of `since` on. */
    forMember(projectKey: string, member: string, since: Date): TokenUsage[] {
      const rows = byMember.all(projectKey, member, usageHour(since)) as UsageRow[];
      return mergeTokenUsage(rows.map(tokenUsageOf));
    },
  };
}

/** The hour bucket of a time: its ISO form cut to the hour ("2026-10-01T19"), which sorts by time. */
export function usageHour(at: Date): string {
  return at.toISOString().slice(0, 13);
}
