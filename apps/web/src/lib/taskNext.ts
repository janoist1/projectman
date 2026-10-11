import { DEFAULT_AGENT_PROVIDER, handOnRequestOf } from '@projectman/shared';
import type { InboxItem, LabelView, Task, TaskWait } from '@projectman/shared';
import { joinNames, t } from '../i18n/t';
import { labelName } from './labels';
import { nameOf } from './members';
import type { MemberIndex } from './members';
import { nextStage } from './pipeline';
import type { PipelineIndex } from './pipeline';

/**
 * "Miért áll?" (PM-461): who acts next and what the card waits for, from the shared `TaskWait`. The card
 * row reads `line`, the drawer's box reads the parts. One text per reason; no internal code reaches
 * the user. Null for the waits that keep today's line: somebody works on the card, it is ready to start.
 */

export type TaskNextTone = 'needs' | 'blocked' | 'neutral';

export interface TaskNextActor {
  handle: string;
  kind: 'human' | 'ai';
  /** The viewer: the box says "Te". */
  you: boolean;
}

export interface TaskNext {
  /** The bold part of the row: a name, or a title when nobody in particular acts; "Rád vár" for the viewer. */
  head: string;
  /** The viewer is next. */
  you: boolean;
  /** What it waits for, short: the rest of the row. */
  waiting: string;
  /** What it waits for, in a sentence, for the box. */
  long: string;
  /** What to do, for the box and the row's title. */
  todo: string;
  tone: TaskNextTone;
  /** Who acts next, for the box; empty when the system or nobody does. */
  who: TaskNextActor[];
  /** The box's "who" row when `who` is empty. */
  noWho: string | null;
  /** Set when `noWho` names a role that someone will fill (the next free Senior), not "nobody". */
  noWhoKind: TaskNextActor['kind'] | null;
  /** The stage the card would enter, for the "Hová lépne" row; null when the wait is not about a move. */
  toStageId: string | null;
  /** "{head} · {waiting}": the row on the card. */
  line: string;
  /** "Ki: … · Mire vár: … · Teendő: …": the row's title and accessible name. */
  title: string;
}

export interface TaskNextContext {
  members: MemberIndex;
  pipeline: PipelineIndex;
  labels: readonly LabelView[];
  myHandle: string | null;
  /** The open inbox item the wait is about, when it is in the context. */
  item: InboxItem | null;
  /** The start wait as a sentence and what it needs (`startWaitingText` / `startWaitingHint`). */
  startText: string | null;
  startHint: string | null;
}

/** The names of the people next: the first two, then how many more ("Te" for the viewer). */
function namesText(next: TaskWait['next'], ctx: Pick<TaskNextContext, 'members' | 'myHandle'>): string {
  const names = next.map((actor) => nameOf(actor.handle, ctx.members, ctx.myHandle));
  if (names.length <= 2) return joinNames(names);
  return t('taskStatus.next.more', {
    names: names.slice(0, 2).join(t('common.listSeparator')),
    more: names.length - 2,
  });
}

function labelsText(ids: readonly string[], labels: readonly LabelView[]): string {
  return joinNames(ids.map((id) => labelName(id, labels)));
}

function quoted(ids: readonly string[], labels: readonly LabelView[]): string {
  return joinNames(ids.map((id) => t('taskStatus.quoted', { name: labelName(id, labels) })));
}

interface Parts {
  head: string;
  you?: boolean;
  waiting: string;
  long: string;
  todo: string;
  tone?: TaskNextTone;
  noWho?: string | null;
  noWhoKind?: TaskNextActor['kind'] | null;
  toStageId?: string | null;
}

export function deriveNext(task: Task, wait: TaskWait, ctx: TaskNextContext): TaskNext | null {
  const { members, pipeline, labels, myHandle } = ctx;
  const stageName = (id: string | null | undefined) => (id ? (pipeline.stageById.get(id)?.name ?? id) : '');
  const here = stageName(task.stageId);
  const meNext = !!myHandle && wait.next.some((actor) => actor.handle === myHandle);
  const names = namesText(wait.next, ctx);
  const nobodyAuto = t('task.whyBox.nobodyAuto');
  const nobodyOpen = t('task.whyBox.nobodyOpen');
  const youHead = t('taskStatus.next.you');

  const build = (parts: Parts): TaskNext => {
    const you = parts.you ?? false;
    const head = you ? youHead : parts.head;
    const line = `${head}${t('taskStatus.next.between')}${parts.waiting}`;
    return {
      head,
      you,
      waiting: parts.waiting,
      long: parts.long,
      todo: parts.todo,
      tone: parts.tone ?? (you ? 'needs' : 'neutral'),
      who: wait.next.map((actor) => ({ ...actor, you: actor.handle === myHandle })),
      noWho: wait.next.length === 0 ? (parts.noWho ?? nobodyAuto) : null,
      noWhoKind: wait.next.length === 0 ? (parts.noWhoKind ?? null) : null,
      toStageId: parts.toStageId ?? null,
      line,
      title: t('taskStatus.next.title', {
        head,
        waiting: parts.waiting,
        todo: parts.todo || t('taskStatus.next.noTodo'),
      }),
    };
  };

  switch (wait.reason) {
    case 'working':
    case 'handing_off':
    case 'ready':
      return null;

    case 'start_waiting': {
      const waiting = wait.startWaiting;
      if (!waiting) return null;
      const reason = waiting.reason;
      const short = t(`taskStatus.next.startReasons.${reason}`, {
        provider: t(`providers.${waiting.provider ?? DEFAULT_AGENT_PROVIDER}`),
        percent: waiting.threshold ?? '',
        labels: labelsText(waiting.labels ?? [], labels),
      });
      const long = ctx.startText ?? short;
      const hint = ctx.startHint ?? '';
      const memberHead = wait.next.length > 0 ? names : null;
      switch (reason) {
        case 'member_at_capacity':
        case 'senior_busy':
          return build({
            head: memberHead ?? t('taskStatus.next.senior'),
            waiting: short,
            long: t('taskStatus.next.long.capacity'),
            // A Senior wait says who decided to keep waiting, and that the card can be given out by hand.
            todo:
              reason === 'senior_busy'
                ? hint || t('taskStatus.next.todo.auto')
                : t('taskStatus.next.todo.auto'),
            // Nobody is named yet, but the Senior who is free first takes the card.
            noWho: t('task.whyBox.nobodySenior'),
            noWhoKind: 'ai',
          });
        case 'no_free_member':
          return build({
            head: t('taskStatus.next.heads.freeMember'),
            waiting: short,
            long,
            todo: hint,
          });
        case 'full_test_pending':
          return build({ head: t('taskStatus.next.heads.fullTest'), waiting: short, long, todo: hint });
        case 'repo_required': {
          const human = !!myHandle && members.get(myHandle)?.kind === 'human';
          return build({
            head: t('taskStatus.next.heads.start'),
            you: human,
            waiting: short,
            long,
            todo: human ? t('taskStatus.next.todo.repo') : hint,
            noWho: nobodyOpen,
          });
        }
        case 'member_on_leave':
        case 'workspace_busy':
        case 'workspace_dirty':
        case 'handoff_open':
        case 'label_missing':
          return build({
            head: memberHead ?? t('taskStatus.next.heads.start'),
            waiting: short,
            long,
            todo: hint,
          });
        default:
          return build({ head: t('taskStatus.next.heads.start'), waiting: short, long, todo: hint });
      }
    }

    case 'prerequisite': {
      const keys = wait.prerequisites;
      const list = keys.length > 2 ? `${keys.slice(0, 2).join(', ')} +${keys.length - 2}` : keys.join(', ');
      return build({
        head: t('taskStatus.next.heads.prerequisite'),
        waiting: list || t('taskStatus.next.heads.prerequisite'),
        long: t('taskStatus.next.long.prerequisite', { keys: keys.join(', ') }),
        // A start that waits for them has its own sentence ("it starts by itself, a person may start it earlier").
        todo: ctx.startHint || t('taskStatus.next.todo.nothing'),
      });
    }

    case 'inbox': {
      const kind = wait.inboxKind ?? ctx.item?.kind ?? 'decision';
      const known = ['question', 'permission', 'decision', 'approval', 'boundary', 'alert'] as const;
      const key = (known as readonly string[]).includes(kind) ? (kind as (typeof known)[number]) : 'other';
      const asker = ctx.item ? nameOf(ctx.item.source, members, myHandle) : '';
      const you = meNext;
      let waiting: string;
      if (!you) waiting = t(`taskStatus.next.short.inbox.${key}`);
      else if (key === 'question')
        waiting = asker
          ? t('taskStatus.next.short.inboxYou.question', { asker })
          : t('taskStatus.next.short.inboxYou.questionNoName');
      else if (key === 'permission')
        waiting = asker
          ? t('taskStatus.next.short.inboxYou.permission', { asker })
          : t('taskStatus.next.short.inboxYou.permissionNoName');
      else waiting = t(`taskStatus.next.short.inboxYou.${key}`);
      return build({
        head: names || t('taskStatus.next.heads.nobody'),
        you,
        waiting,
        long: t('taskStatus.next.long.inbox', { kind: t(`inbox.kindsLower.${kind}`) }),
        todo: you
          ? t('taskStatus.next.todo.inboxYou')
          : t('taskStatus.next.todo.inboxOther', { who: names || t('taskStatus.next.heads.nobody') }),
      });
    }

    case 'hand_on': {
      const request = task.handOn ?? (ctx.item ? handOnRequestOf(ctx.item) : null);
      const owner = request ? nameOf(request.requestedBy, members, myHandle) : '';
      const step = stageName(request?.fromStageId ?? task.stageId);
      const long = owner
        ? t('taskStatus.next.long.handOn', { owner, step })
        : t('taskStatus.next.long.handOnNoOwner', { step });
      return build({
        head: t('taskStatus.next.heads.done'),
        you: meNext,
        waiting: meNext
          ? t('taskStatus.next.short.handOnYou')
          : t('taskStatus.next.short.handOn', { mover: names || t('taskStatus.next.heads.nobody') }),
        long,
        todo: meNext
          ? t('taskStatus.next.todo.handOnYou')
          : t('taskStatus.next.todo.handOn', { mover: names || t('taskStatus.next.heads.nobody') }),
        toStageId: wait.toStageId,
      });
    }

    case 'approval': {
      const to = stageName(wait.toStageId);
      const waiting = to
        ? t('taskStatus.next.short.approval', { from: here, to })
        : t('taskStatus.next.short.labels', { labels: quoted(wait.labels, labels) });
      return build({
        head: names,
        you: meNext,
        waiting,
        long: t('taskStatus.next.long.approval', { labels: quoted(wait.labels, labels) }),
        todo: meNext
          ? t('taskStatus.next.todo.approval')
          : t('taskStatus.next.todo.approvalOther', { who: names }),
        toStageId: wait.toStageId,
      });
    }

    case 'fix_limit': {
      const rounds = task.fixLimit?.rounds ?? 0;
      return build({
        head: names || t('taskStatus.next.heads.nobody'),
        you: meNext,
        waiting: meNext
          ? t('taskStatus.next.short.fixLimitYou', { rounds })
          : t('taskStatus.next.short.fixLimit', { rounds }),
        long: t('taskStatus.next.long.fixLimit', { rounds }),
        todo: meNext
          ? t('taskStatus.next.todo.fixLimit')
          : t('taskStatus.next.todo.fixLimitOther', { who: names || t('taskStatus.next.heads.nobody') }),
        noWho: nobodyOpen,
      });
    }

    case 'held': {
      const held = quoted(wait.labels, labels);
      return build({
        head: t('taskStatus.next.heads.held'),
        waiting: t('taskStatus.next.short.held', { labels: held }),
        long: t('taskStatus.next.long.held', { labels: held }),
        todo: t('taskStatus.next.todo.held'),
        noWho: nobodyOpen,
      });
    }

    case 'blocked':
      return build({
        head: t('taskStatus.next.heads.blocked'),
        waiting: t('taskStatus.next.short.blocked'),
        long: t('taskStatus.next.long.blocked'),
        todo: t('taskStatus.next.todo.blocked'),
        tone: 'blocked',
        noWho: nobodyOpen,
      });

    case 'labels_missing':
    case 'refinement': {
      // Nobody in particular and no label to name: the card keeps its own line.
      if (wait.next.length === 0 && wait.labels.length === 0) return null;
      const text = labelsText(wait.labels, labels);
      return build({
        head: names || t('taskStatus.next.heads.refinement'),
        you: meNext,
        waiting: text
          ? t('taskStatus.next.short.labels', { labels: text })
          : t('taskStatus.next.heads.refinement'),
        long: t('taskStatus.next.long.labels', { labels: quoted(wait.labels, labels) }),
        todo: meNext
          ? t('taskStatus.next.todo.labelsYou')
          : t('taskStatus.next.todo.labels', { who: names || t('taskStatus.next.heads.refinement') }),
        toStageId: null,
      });
    }

    case 'part_left': {
      // A part its creator left in the first stage: the creator takes it on, to the stage with the gate's labels.
      const to = stageName(wait.toStageId);
      const needed = labelsText(wait.labels, labels);
      return build({
        head: names || t('taskStatus.next.heads.nobody'),
        you: meNext,
        waiting: meNext
          ? t('taskStatus.next.short.partLeftYou', { stage: here, to })
          : t('taskStatus.next.short.partLeft', { stage: here }),
        long: needed
          ? t('taskStatus.next.long.partLeftLabels', { stage: here, to, labels: needed })
          : t('taskStatus.next.long.partLeft', { stage: here, to }),
        todo: meNext
          ? t('taskStatus.next.todo.partLeftYou', { to })
          : t('taskStatus.next.todo.partLeft', { who: names || t('taskStatus.next.heads.nobody') }),
        toStageId: null,
      });
    }

    case 'queued': {
      const [first] = wait.next;
      if (first?.kind === 'human') {
        const to = nextStage(pipeline, task.stageId)?.id ?? null;
        return build({
          head: names,
          you: meNext,
          waiting: meNext
            ? t('taskStatus.next.short.queuedHumanYou', { stage: here })
            : t('taskStatus.next.short.queuedHuman', { stage: here }),
          long: t('taskStatus.next.long.queuedHuman', { stage: here }),
          todo: meNext
            ? t('taskStatus.next.todo.queuedHumanYou')
            : t('taskStatus.next.todo.queuedHuman', { who: names }),
          toStageId: to,
        });
      }
      if (first) {
        return build({
          head: names,
          waiting: t('taskStatus.next.short.takes'),
          long: t('taskStatus.next.long.takes', { stage: here }),
          todo: t('taskStatus.next.todo.takes'),
        });
      }
      return build({
        head: t('taskStatus.next.heads.queued'),
        waiting: t('taskStatus.next.short.queuedStage', { stage: here }),
        long: t('taskStatus.next.long.queuedStage', { stage: here }),
        todo: t('taskStatus.next.todo.takes'),
      });
    }

    case 'assignee':
      return build({
        head: names,
        waiting: t('taskStatus.next.short.takes'),
        long: t('taskStatus.next.long.takes', { stage: here }),
        todo: t('taskStatus.next.todo.takes'),
      });

    case 'nobody':
      return build({
        head: t('taskStatus.next.heads.nobody'),
        waiting: t('taskStatus.next.short.nobody'),
        long: t('taskStatus.next.long.nobody', { stage: here }),
        todo: t('taskStatus.next.todo.nobody'),
        tone: 'blocked',
        noWho: t('task.whyBox.nobodySetup'),
      });
  }
}
