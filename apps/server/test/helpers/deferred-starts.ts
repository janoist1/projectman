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
