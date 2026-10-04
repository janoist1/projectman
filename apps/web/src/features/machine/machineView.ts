import type { MachineSessionRow, MachineView, WorkItemRef } from '@projectman/shared';
import { t } from '../../i18n/t';

export type MachineSort = 'memory' | 'cpu' | 'age';
export const percent = (part: number | null, total: number | null) =>
  part === null || total === null || total <= 0 ? null : (part * 100) / total;

export function isDelayed(data: MachineView, now: number): boolean {
  return data.sampledAt === null || now - Date.parse(data.sampledAt) > 3 * data.intervalMs;
}

export function workName(work: WorkItemRef): string {
  return work.type === 'task' ? work.taskKey : t(`pause.progress.work.${work.type}`);
}

/** Missing measurements always go last, regardless of sort direction. */
export function sortSessions(
  rows: MachineSessionRow[],
  sort: MachineSort,
  ascending: boolean,
): MachineSessionRow[] {
  const value = (row: MachineSessionRow) =>
    sort === 'memory'
      ? row.memoryBytes
      : sort === 'cpu'
        ? row.cpuPercent
        : row.processStartedAt === null
          ? null
          : -Date.parse(row.processStartedAt);
  return [...rows].sort((a, b) => {
    const av = value(a),
      bv = value(b);
    if (av === null) return bv === null ? 0 : 1;
    if (bv === null) return -1;
    return (av - bv) * (ascending ? 1 : -1);
  });
}

export function holdOrder(previous: string[], sorted: MachineSessionRow[]): string[] {
  return holdKeys(
    previous,
    sorted.map((row) => row.sessionId),
  );
}

export function holdKeys(previous: string[], ids: string[]): string[] {
  const live = new Set(ids);
  const kept = previous.filter((id) => live.has(id));
  return [...kept, ...ids.filter((id) => !kept.includes(id))];
}
