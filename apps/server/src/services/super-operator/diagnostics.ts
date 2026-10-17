import { SUPER_DIAGNOSTIC_COLUMNS, superOperationName } from '@projectman/shared';
import type {
  SuperDiagnosticQuery,
  SuperDiagnosticValue,
  SuperDiagnosticsRequest,
  SuperDiagnosticsResponse,
} from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import { notFound } from '../../kernel';

type Row = Record<string, SuperDiagnosticValue>;

/**
 * The super mode's filtered diagnostics (PM-764): a closed catalogue of the project's own records, read by name
 * and by nothing else. There is no SQL, no table or column argument and no writable handle: each query is a
 * fixed read of the repositories, and the answer carries only the columns `SUPER_DIAGNOSTIC_COLUMNS` lists, so a
 * user, a key, a secret, an inbox text or any other personal data cannot appear in it.
 */
export function createSuperDiagnostics(deps: { ctx: DomainContext }) {
  const repos = () => deps.ctx.repos;

  /** At most `limit + 1` rows are needed: the extra one only tells that the answer was cut. */
  const read: Record<SuperDiagnosticQuery, (projectKey: string, request: SuperDiagnosticsRequest) => Row[]> =
    {
      tasks(projectKey, { taskKey }) {
        return repos()
          .tasks.list(projectKey)
          .filter((task) => !taskKey || task.key === taskKey)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key))
          .map((task) => ({
            key: task.key,
            stage: task.stageId,
            status: task.status,
            assignee: task.assignee,
            updatedAt: task.updatedAt,
          }));
      },
      sessions(projectKey, { taskKey }) {
        return repos()
          .sessions.list(projectKey, taskKey ? { taskKey } : {})
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id))
          .map((session) => ({
            id: session.id,
            taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
            member: session.member,
            state: session.state,
            engineId: session.engineId ?? 'local',
          }));
      },
      merges(projectKey, { taskKey }) {
        const rows: Row[] = [];
        for (const task of repos().tasks.list(projectKey)) {
          if (taskKey && task.key !== taskKey) continue;
          if (task.merge)
            rows.push({
              taskKey: task.key,
              repo: task.merge.repo,
              state: task.merge.state,
              commit: task.merge.commit ?? null,
            });
          if (task.merged)
            rows.push({
              taskKey: task.key,
              repo: task.merged.repo,
              state: 'merged',
              commit: task.merged.commit,
            });
        }
        return rows.sort((a, b) => String(a.taskKey).localeCompare(String(b.taskKey)));
      },
      operations(projectKey, { taskKey, limit }) {
        return repos()
          .superHandoffs.listOperations(projectKey, { ...(taskKey ? { taskKey } : {}), limit: limit + 1 })
          .map((operation) => ({
            id: operation.id,
            taskKey: operation.taskKey,
            state: operation.state,
            operation: superOperationName(operation.command),
            createdAt: operation.createdAt,
            updatedAt: operation.updatedAt,
          }));
      },
    };

  return {
    query(projectKey: string, request: SuperDiagnosticsRequest): SuperDiagnosticsResponse {
      if (request.taskKey && repos().tasks.get(request.taskKey)?.projectKey !== projectKey)
        throw notFound('task', request.taskKey);
      const columns = [...SUPER_DIAGNOSTIC_COLUMNS[request.query]];
      const rows = read[request.query](projectKey, request);
      return {
        columns,
        // Only the catalogue's columns, in its order, whatever the read built.
        rows: rows.slice(0, request.limit).map((row) => columns.map((column) => row[column] ?? null)),
        truncated: rows.length > request.limit,
      };
    },
  };
}
export type SuperDiagnostics = ReturnType<typeof createSuperDiagnostics>;
