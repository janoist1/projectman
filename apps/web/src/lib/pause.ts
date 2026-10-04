import type { PauseStatus } from '@projectman/shared';
import { t } from '../i18n/t';

/**
 * Why the pause is open, as the bar and the timeline say it: "élesítés miatt", "újraindítás miatt",
 * any other text as it came; a pause the control command asked for without a reason is a deploy.
 * Null: no reason.
 */
export function reasonText(pause: Pick<PauseStatus, 'reason' | 'source'>): string | null {
  if (pause.reason === 'deploy') return t('pause.reason.deploy');
  if (pause.reason === 'restart') return t('pause.reason.restart');
  if (pause.reason) return pause.reason;
  return pause.source === 'control' ? t('pause.reason.deploy') : null;
}
