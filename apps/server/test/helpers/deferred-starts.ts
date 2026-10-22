import type { DeferredStartRecord, Repositories } from '../../src/db';

/** Deferred starts can live in the legacy store or the member queue (PM-927). */
export function deferredStartRecords(
  repos: Pick<Repositories, 'deferredStarts' | 'memberQueue'>,
): DeferredStartRecord[] {
  return [
    ...repos.deferredStarts.list(),
    ...repos.memberQueue.listOpenOfType('start').map((item) => {
      const payload = repos.memberQueue.payload(item.id) as {
        key: string;
        spec: unknown;
        waiting: unknown;
      } | null;
      return {
        key: payload?.key ?? item.source.id,
        projectKey: item.projectKey,
        taskKey: item.taskKey,
        spec: payload?.spec,
        waiting: payload?.waiting,
      };
    }),
  ];
}

/** Obligation reminders include closed items: each obligation can wake its responsible only once. */
export function obligationReminders(
  repos: Pick<Repositories, 'db' | 'memberQueue'>,
  projectKey: string,
  taskKey?: string,
) {
  const rows = repos.db
    .prepare(
      "SELECT id FROM member_queue_items WHERE project_key = ? AND source_type = 'obligation' ORDER BY rowid",
    )
    .all(projectKey) as Array<{ id: string }>;
  return rows
    .map(({ id }) => ({
      ...repos.memberQueue.get(id)!,
      text: (repos.memberQueue.payload(id) as { text: string }).text,
    }))
    .filter((item) => taskKey === undefined || item.taskKey === taskKey);
}
