import { z } from 'zod';
import type { AlertPayload, InboxItem, QuestionTodo } from '@projectman/shared';

const GB = 1024 ** 3;

/** The alert kinds that become a todo for the integrator (`ALERT_ROUTE_CLASS`: `integrator_queue`). */
export type MachineAlert = Extract<
  AlertPayload,
  { alert: 'disk_low' | 'machine_busy' | 'worktree_kept' | 'session_input' }
>;

export function isMachineAlert(alert: AlertPayload): alert is MachineAlert {
  return (
    alert.alert === 'disk_low' ||
    alert.alert === 'machine_busy' ||
    alert.alert === 'worktree_kept' ||
    alert.alert === 'session_input'
  );
}

/** What marks a todo as the one of an alert kind and card: at most one is open for each pair. */
const AlertMarker = z.object({ alert: z.string(), key: z.string() });
type AlertMarker = z.infer<typeof AlertMarker>;
const MARKER = 'systemAlert';

/** The machine alerts that belong to the project as a whole, not to a card or a session. */
export function isProjectAlert(alert: string): boolean {
  return alert === 'disk_low' || alert === 'machine_busy';
}

/** The marker an alert todo carries on its payload. `key` is the card, else the session, else empty (the project). */
export function alertMarkerOf(
  alert: MachineAlert,
  scope: { taskKey: string | null; sessionId: string | null },
): AlertMarker {
  return {
    alert: alert.alert,
    key: isProjectAlert(alert.alert) ? '' : (scope.taskKey ?? scope.sessionId ?? ''),
  };
}

export function alertMarkerPayload(marker: AlertMarker): Record<string, unknown> {
  return { [MARKER]: marker };
}

/** The marker of an item, or null when it is no alert todo. */
export function alertMarkerOfItem(item: Pick<InboxItem, 'payload'>): AlertMarker | null {
  const parsed = AlertMarker.safeParse(item.payload[MARKER]);
  return parsed.success ? parsed.data : null;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What the integrator is asked to do about a machine alert (English: it is read by the integrator's AI). */
export function alertTodoOf(
  alert: MachineAlert,
  scope: { member: string; sessionId: string | null },
): QuestionTodo {
  switch (alert.alert) {
    case 'disk_low':
      return {
        what: `The free disk space is ${Math.floor(alert.freeBytes / GB)} GB, below the limit of ${alert.thresholdBytes / GB} GB, so no new AI session starts. Free space: remove what is not needed (caches, old worktrees, build output).`,
        where: 'The disk of the machine the engine runs on.',
        expected: 'The free space is above the limit again; say what was removed.',
      };
    case 'machine_busy':
      return {
        what: `The memory of the machine the engine runs on has been under critical pressure for ${alert.minutes} minutes, so no new AI session starts. Look at what uses the memory (dev servers, Docker, browsers, other programs) and stop what is not needed.`,
        where: 'The machine the engine runs on.',
        expected: 'The memory pressure is back to normal or warn; say what was stopped.',
      };
    case 'worktree_kept':
      return {
        what: `The cleanup of closed cards kept the worktree of ${alert.taskKey}: it has ${alert.changes} uncommitted file(s) that removing it would lose. Look at them and commit, save or discard them, then remove the worktree.`,
        where: cut(alert.path, 480),
        expected: 'The changes are saved or discarded and the worktree is removed.',
      };
    case 'session_input':
      return {
        what: `The session of ${scope.member} has waited for input at its terminal for ${alert.minutes} minutes and no question explains it${alert.activity ? ` (last seen: ${cut(alert.activity, 200)})` : ''}. Messages for it are held back until it carries on.`,
        where: scope.sessionId ? `Session ${scope.sessionId}.` : `The session of ${scope.member}.`,
        expected: 'The session carries on, or it is stopped.',
      };
  }
}
