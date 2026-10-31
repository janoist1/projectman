import type { DocumentVersion } from '@projectman/shared';
import { t } from '../../i18n/t';

/**
 * The text of a change in the history. The store writes an English default when the author gave no message
 * (`Create <slug>`, `Update <slug>`, `Rename <slug>`, `Restore <slug> to <version>`, `Delete <slug>`);
 * the page shows those in the UI language and every message an author wrote as it is.
 */
export function changeMessage(version: Pick<DocumentVersion, 'message'>, slug: string): string {
  const { message } = version;
  if (message === `Create ${slug}`) return t('documents.history.created');
  if (message === `Update ${slug}`) return t('documents.history.updated');
  if (message === `Rename ${slug}`) return t('documents.history.renamedChange');
  if (message === `Delete ${slug}`) return t('documents.history.deleted');
  if (message.startsWith(`Restore ${slug} to `)) return t('documents.history.restoredChange');
  return message;
}
