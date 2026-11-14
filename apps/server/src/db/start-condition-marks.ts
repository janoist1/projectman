import type { Db } from './database';

export function createStartConditionMarkRepository(db: Db) {
  const read = db.prepare('SELECT task_key, met_since FROM start_condition_marks WHERE project_key = ?');
  const add = db.prepare(
    'INSERT INTO start_condition_marks (task_key, project_key, met_since) VALUES (?, ?, ?)',
  );
  const remove = db.prepare('DELETE FROM start_condition_marks WHERE project_key = ? AND task_key = ?');
  const clear = db.prepare('DELETE FROM start_condition_marks WHERE project_key = ?');
  return {
    ofProject(projectKey: string): Map<string, string> {
      return new Map(
        (read.all(projectKey) as { task_key: string; met_since: string }[]).map((row) => [
          row.task_key,
          row.met_since,
        ]),
      );
    },
    apply(
      projectKey: string,
      changes: { add: { taskKey: string; metSince: string }[]; remove: string[] },
    ): void {
      db.transaction(() => {
        for (const key of changes.remove) remove.run(projectKey, key);
        for (const mark of changes.add) add.run(mark.taskKey, projectKey, mark.metSince);
      })();
    },
    clearProject(projectKey: string): void {
      clear.run(projectKey);
    },
  };
}
