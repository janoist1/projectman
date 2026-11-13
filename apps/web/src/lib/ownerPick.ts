import { StageOwnerPickReason } from '@projectman/shared';
import { t } from '../i18n/t';

/** The sentence of a pick reason in parts: a central file is set apart so the card can draw it as code. */
export interface PickReasonText {
  before: string;
  /** The first central file; absent for every other reason. */
  file?: string;
  /** What follows the file ("(és még 2)"); empty when nothing does. */
  after?: string;
  /** Every file the reason names, for a `title`. */
  files?: readonly string[];
}

/** Why the stage gave the card to those it did (PM-1378); null for a reason this build does not know (a newer one). */
export function pickReasonText(value: unknown): PickReasonText | null {
  const parsed = StageOwnerPickReason.safeParse(value);
  if (!parsed.success) return null;
  const reason = parsed.data;
  switch (reason.code) {
    case 'small':
      return { before: t('task.ownerPick.small', { points: reason.points }) };
    case 'over_limit':
      return {
        before: t('task.ownerPick.over_limit', { points: reason.points, maxPoints: reason.maxPoints }),
      };
    case 'central_files': {
      const [file] = reason.files;
      return {
        before: t('task.ownerPick.central_files'),
        ...(file === undefined ? {} : { file }),
        after: reason.count > 1 ? t('task.ownerPick.central_more', { count: reason.count - 1 }) : '',
        files: reason.files,
      };
    }
    default:
      return { before: t(`task.ownerPick.${reason.code}`) };
  }
}

/** The sentence as plain text (the timeline). */
export function pickReasonSentence(value: unknown): string | null {
  const parts = pickReasonText(value);
  if (!parts) return null;
  return [parts.before, parts.file, parts.after].filter((part) => part).join(' ');
}
