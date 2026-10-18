import type { SuperState } from '@projectman/shared';
import { Link } from 'react-router';
import { t } from '../i18n/t';
import { inboxItemDomId } from '../lib/inbox';
import { Chip } from './Chip';
import type { ChipTone } from './Chip';

const tones: Record<SuperState, ChipTone> = {
  pending: 'needs',
  waiting_owner: 'needs',
  running: 'accent',
  succeeded: 'ok',
  failed: 'blocked',
  cancelled: 'neutral',
  unknown: 'needs',
};
export function SuperStateChip({
  state,
  projectKey,
  questionId,
}: {
  state: SuperState;
  projectKey: string;
  questionId?: string | null;
}) {
  const chip = (
    <Chip tone={tones[state]} title={state === 'unknown' ? t('superMode.unknownHint') : undefined}>
      {t(`superMode.states.${state}`)}
    </Chip>
  );
  return state === 'waiting_owner' ? (
    <Link to={`/p/${projectKey}/inbox${questionId ? `#${inboxItemDomId(questionId)}` : ''}`}>{chip}</Link>
  ) : (
    chip
  );
}
