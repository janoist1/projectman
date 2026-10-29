import type { OperatorHandoff as Handoff } from '@projectman/shared';
import { ButtonLink } from '../../components/Button';
import { Fold } from '../../components/Fold';
import { Markdown } from '../../components/Markdown';
import { t } from '../../i18n/t';

export function OperatorHandoff({ handoff, cardHref }: { handoff: Handoff; cardHref: string | null }) {
  return (
    <div>
      <p>
        <strong>{t('inbox.handedOff.why')}</strong> {t(`inbox.handedOff.reasons.${handoff.reason}`)}
      </p>
      {handoff.detail !== null ? (
        <Fold summary={t('inbox.handedOff.detail')}>
          <Markdown text={handoff.detail} />
        </Fold>
      ) : null}
      {handoff.reason === 'processing_failed' && cardHref ? (
        <ButtonLink variant="primary" to={cardHref}>
          {t('inbox.handedOff.openCard')}
        </ButtonLink>
      ) : null}
    </div>
  );
}
