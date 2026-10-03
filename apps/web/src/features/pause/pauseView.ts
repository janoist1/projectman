import type { PausedSession, PauseStatus, PausePoint, ProjectPauseView } from '@projectman/shared';
import { formatStamp } from '../../i18n/format';
import { t } from '../../i18n/t';
import { toolPresentationFor } from '../../lib/chat';

/** The pauses that are open: the instance's first, then the project's. */
export function openPauses(view: ProjectPauseView | undefined | null): PauseStatus[] {
  return [view?.instance, view?.project].filter((pause): pause is PauseStatus => Boolean(pause));
}

/**
 * The pause the bar shows: the instance's when both are open (its Folytatás is the bigger one), and
 * the project's pause as `other`, which the details name on a row of its own.
 */
export function visiblePause(
  view: ProjectPauseView | undefined | null,
): { pause: PauseStatus; other: PauseStatus | null } | null {
  if (view?.instance) return { pause: view.instance, other: view.project ?? null };
  return view?.project ? { pause: view.project, other: null } : null;
}

/**
 * The sessions the open pauses hold, by session id. A session in both pauses reads as the one that
 * has not stopped yet (a row without a point wins).
 */
export function pausedSessionMap(view: ProjectPauseView | undefined | null): Map<string, PausedSession> {
  const map = new Map<string, PausedSession>();
  for (const pause of openPauses(view))
    for (const row of pause.sessions) {
      const known = map.get(row.sessionId);
      if (!known || (known.point !== null && row.point === null)) map.set(row.sessionId, row);
    }
  return map;
}

/**
 * The rows of this project's sessions the open pauses hold, for the member status (`memberStatusView`);
 * undefined while no pause is open, an empty list when one is open and nothing was running.
 */
export function pausedRowsOf(
  view: ProjectPauseView | undefined | null,
  projectKey: string,
): PausedSession[] | undefined {
  if (openPauses(view).length === 0) return undefined;
  return [...pausedSessionMap(view).values()].filter((row) => row.projectKey === projectKey);
}

/** The server stops: the bar says so and has no Folytatás. */
export function isShutdownPause(pause: Pick<PauseStatus, 'kind'>): boolean {
  return pause.kind === 'shutdown';
}

/** How many sessions have stopped (a point is set) and how many the pause holds. */
export function stoppedCount(pause: Pick<PauseStatus, 'sessions'>): { done: number; total: number } {
  return {
    done: pause.sessions.filter((row) => row.point !== null).length,
    total: pause.sessions.length,
  };
}

/** The sessions that still run first (the longest running first), then those that stopped (the earliest first). */
export function sortRows(rows: readonly PausedSession[]): PausedSession[] {
  return [...rows].sort((a, b) => {
    const running = Number(a.point !== null) - Number(b.point !== null);
    if (running !== 0) return running;
    return a.point === null
      ? a.since.localeCompare(b.since)
      : (a.pausedAt ?? a.since).localeCompare(b.pausedAt ?? b.since);
  });
}

export { reasonText } from '../../lib/pause';

/** A tool's name in the UI language ("Bash" → "Parancs"); an unknown name stays as it is. */
export function toolLabel(name: string | null | undefined): string {
  return name ? toolPresentationFor(name).label : t('session.tools.other');
}

/** "Megállt: Parancs után", "Megállt: a kör végén": where a session stopped. */
export function pointText(point: PausePoint, tool: string | null): string {
  switch (point) {
    case 'after_tool':
    case 'before_tool':
    case 'interrupted':
      return t(`session.pausePoint.${point}`, { tool: toolLabel(tool) });
    default:
      return t(`session.pausePoint.${point}`);
  }
}

/** "Megáll: Parancs fut még": a session that has not stopped. */
export function runningText(waitingFor: string | null): string {
  return t('session.pausePoint.running', { tool: toolLabel(waitingFor) });
}

/** The longer explanation of a point that cut a step; null for the others. */
export function pointExplanation(point: PausePoint): string | null {
  return point === 'after_tool' || point === 'before_tool' || point === 'interrupted'
    ? t(`session.pausePoint.explain.${point}`)
    : null;
}

/** Milliseconds until the running steps are cut; null once the deadline is over (nothing to wait for). */
export function forceCountdown(pause: Pick<PauseStatus, 'forceAt'>, now: number): number | null {
  const left = Date.parse(pause.forceAt) - now;
  return left > 0 ? left : null;
}

/** "Megállítás most" has something to cut: a session still runs and the deadline is not over. */
export function canForceNow(pause: Pick<PauseStatus, 'sessions' | 'forceAt'>, now: number): boolean {
  return pause.sessions.some((row) => row.point === null) && forceCountdown(pause, now) !== null;
}

/** "14:02 óta", or with the date for an earlier day. */
export function sinceText(value: string, now: Date = new Date()): string {
  return t('pause.banner.since', { time: formatStamp(value, now) });
}
