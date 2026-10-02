import type { BoardGroupItem, BoardMoveResult, LabelView } from '@projectman/shared';
import type { ToastItem, ToastTone } from '../../components/toastContext';
import { joinNames, t } from '../../i18n/t';
import { labelName } from '../../lib/labels';

/** Lines listed under the toast of a group move; the rest is counted. */
const MAX_LINES = 5;

export interface GroupMoveToast {
  message: string;
  tone: ToastTone;
  /** Anything that did not move has to be read, so the toast stays until it is closed. */
  sticky: boolean;
  items: ToastItem[];
}

/** The cards of a group move result that moved, and those that stayed (held back, waiting, or skipped). */
export function groupOutcome(result: BoardMoveResult): { moved: string[]; held: BoardGroupItem[] } {
  const group = result.group ?? [];
  return {
    moved: group.filter((item) => item.outcome === 'moved').map((item) => item.taskKey),
    held: group.filter((item) => item.outcome !== 'moved'),
  };
}

/** Why a card stayed, in a few words. */
export function heldReason(item: BoardGroupItem, labels: readonly LabelView[]): string {
  switch (item.outcome) {
    case 'moved':
      return '';
    case 'approval_pending':
      return t('board.groupMove.reason.approval');
    case 'skipped':
      return t('board.groupMove.reason.skipped');
    case 'blocked': {
      if (item.code === 'handover_uncommitted') return t('board.groupMove.reason.uncommitted');
      if (item.code === 'no_approver') {
        const label = item.approvals[0]?.label;
        return label
          ? t('board.groupMove.reason.noApprover', { label: labelName(label, labels) })
          : t('board.groupMove.reason.noApproverUnnamed');
      }
      const named = (type: 'has_label' | 'lacks_label') =>
        item.unmet
          .filter((entry) => entry.condition.type === type)
          .map((entry) => labelName(entry.condition.label, labels));
      const missing = named('has_label');
      const holding = named('lacks_label');
      const parts = [
        ...(missing.length ? [t('board.groupMove.reason.missing', { labels: joinNames(missing) })] : []),
        ...holding.map((label) => t('board.groupMove.reason.holding', { label })),
      ];
      return parts.length ? parts.join('. ') : t('board.groupMove.reason.unknown');
    }
  }
}

/**
 * The one toast that tells a group move: everything moved (a short confirmation), part of it (what moved,
 * then what stayed and why), or nothing (an error). The cards that moved are never taken back.
 */
export function groupMoveToast(input: {
  result: BoardMoveResult;
  parentKey: string;
  columnName: string;
  projectKey: string;
  labels: readonly LabelView[];
}): GroupMoveToast {
  const { result, parentKey, columnName, projectKey, labels } = input;
  const { moved, held } = groupOutcome(result);
  const children = moved.filter((key) => key !== parentKey).length;
  const parentMoved = moved.includes(parentKey);
  const first = !moved.length
    ? t('board.groupMove.none')
    : parentMoved && children > 0
      ? t('board.groupMove.parentAndChildren', { key: parentKey, count: children, column: columnName })
      : parentMoved
        ? t('board.groupMove.parentOnly', { key: parentKey, column: columnName })
        : t('board.groupMove.childrenOnly', { count: children, column: columnName });
  if (!held.length) return { message: first, tone: 'ok', sticky: false, items: [] };

  const lines: ToastItem[] = held.slice(0, MAX_LINES).map((item) => ({
    key: item.taskKey,
    text: heldReason(item, labels),
    to: `/p/${projectKey}/tasks/${item.taskKey}`,
  }));
  if (held.length > MAX_LINES)
    lines.push({
      key: 'more',
      bare: true,
      text: t('board.groupMove.more', { count: held.length - MAX_LINES }),
    });
  return {
    message: `${first} ${t('board.groupMove.stayed')}`,
    tone: moved.length ? 'info' : 'error',
    sticky: true,
    items: lines,
  };
}
