import type { TaskWait } from '@projectman/shared';

/**
 * Why a card stands still (PM-460), for an AI member: `get_task` shows the long sentence, `list_tasks`
 * the short part. Both name members by handle and stages and labels by id, as the rest of the tool
 * results do. The reason itself comes from `taskWait` in `packages/shared`; this only words it.
 */

function who(wait: TaskWait): string {
  return wait.next.map((actor) => `${actor.handle} (${actor.kind})`).join(', ');
}

function handles(wait: TaskWait): string {
  return wait.next.map((actor) => actor.handle).join(', ');
}

function labelsOf(wait: TaskWait): string {
  return wait.labels.join(', ');
}

/** The sentence `get_task` shows after "Waiting:". */
export function describeTaskWait(wait: TaskWait): string {
  const by = wait.next.length > 0 ? ` — ${who(wait)}` : '';
  switch (wait.reason) {
    case 'working':
      return `${handles(wait)} ${wait.next.length > 1 ? 'work' : 'works'} on it now.`;
    case 'handing_off':
      return `${handles(wait)} hands the card over (writes the handoff note).`;
    case 'start_waiting': {
      const start = wait.startWaiting;
      return `its start waits (${start?.reason ?? 'unknown'})${by}.`;
    }
    case 'prerequisite':
      return wait.prerequisites.length > 0
        ? `open prerequisite${wait.prerequisites.length > 1 ? 's' : ''}: ${wait.prerequisites.join(', ')}.`
        : 'an open prerequisite holds it.';
    case 'inbox':
      return `an open ${wait.inboxKind ?? 'request'} waits for ${handles(wait) || 'someone'}.`;
    case 'blocked':
      return 'the card is blocked: someone has to unblock it.';
    case 'fix_limit':
      return `held at the fix round limit; a decision is needed${by}.`;
    case 'held':
      return `held by the label${wait.labels.length > 1 ? 's' : ''} ${labelsOf(wait)}; whoever set it takes it off.`;
    case 'hand_on':
      return `the work is done; ${handles(wait) || 'the card mover'} moves it on${wait.toStageId ? ` to ${wait.toStageId}` : ''}.`;
    case 'approval':
      return `waits for the approval ${labelsOf(wait)} of ${handles(wait) || 'a person'}${wait.toStageId ? ` (to enter ${wait.toStageId})` : ''}.`;
    case 'labels_missing':
      return `missing label${wait.labels.length > 1 ? 's' : ''} ${labelsOf(wait)}${wait.next.length > 0 ? `, set by ${handles(wait)}` : ''}.`;
    case 'part_left':
      return `a part of a broken-down card was left in its first stage: ${handles(wait) || 'its creator'} takes it on (${wait.labels.length > 0 ? `labels ${labelsOf(wait)} → ${wait.toStageId ?? 'the next stage'}, or ` : ''}refine).`;
    case 'refinement':
      return `a refinement step is on turn${wait.labels.length > 0 ? ` (${labelsOf(wait)})` : ''}${by}.`;
    case 'ready':
      return `ready in its queue; it can be started${wait.toStageId ? ` (next: ${wait.toStageId})` : ''}.`;
    case 'queued':
      return wait.next.length > 0 ? `queued for ${handles(wait)}.` : 'queued for the owner of its stage.';
    case 'assignee':
      return `${handles(wait)} takes it on (its assignee).`;
    case 'nobody':
      return `nobody can take it on${wait.labels.length > 0 ? ` (${labelsOf(wait)})` : ''}: the set-up needs fixing.`;
  }
}

/** The short part `list_tasks` shows per card: who or what it waits for. */
export function taskWaitShort(wait: TaskWait): string {
  switch (wait.reason) {
    case 'working':
      return `worked on by ${handles(wait)}`;
    case 'handing_off':
      return `handed over by ${handles(wait)}`;
    case 'prerequisite':
      return `waits for ${wait.prerequisites.join(', ') || 'a prerequisite'}`;
    case 'blocked':
      return 'blocked';
    case 'held':
      return `held by ${labelsOf(wait)}`;
    case 'labels_missing':
      return `waits for ${labelsOf(wait)}`;
    case 'part_left':
      return `part left in its first stage; ${handles(wait) || 'its creator'} takes it on`;
    case 'ready':
      return 'ready to start';
    case 'nobody':
      return 'nobody can take it on';
    case 'start_waiting':
      return `its start waits${wait.startWaiting ? ` (${wait.startWaiting.reason})` : ''}`;
    case 'inbox':
      return `waits for ${handles(wait) || 'an open request'}`;
    case 'fix_limit':
      return `waits for a decision at the fix round limit${wait.next.length > 0 ? ` (${handles(wait)})` : ''}`;
    case 'hand_on':
      return `done, to be moved on by ${handles(wait) || 'the card mover'}`;
    case 'approval':
      return `waits for the approval of ${handles(wait) || 'a person'}`;
    case 'refinement':
      return `refinement step on turn${wait.next.length > 0 ? ` (${handles(wait)})` : ''}`;
    case 'queued':
      return `queued for ${handles(wait) || 'the owner of its stage'}`;
    case 'assignee':
      return `waits for ${handles(wait) || 'its assignee'}`;
  }
}
