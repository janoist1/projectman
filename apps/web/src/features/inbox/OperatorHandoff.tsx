import type { OperatorHandoff as Handoff } from '@projectman/shared';
import { useOperatorGrant } from '../../api/queries';
import { ButtonLink } from '../../components/Button';
import { Fold } from '../../components/Fold';
import { Markdown } from '../../components/Markdown';
import { t } from '../../i18n/t';

export function OperatorHandoff({
  handoff,
  projectKey,
  cardHref,
}: {
  handoff: Handoff;
  projectKey: string;
  cardHref: string | null;
}) {
  const grant = useOperatorGrant();
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
      {handoff.reason === 'no_grant' ? (
        grant.data?.grant.active ? (
          <p>{t('inbox.handedOff.nowGranted')}</p>
        ) : grant.data?.grant.canManage ? (
          <ButtonLink variant="primary" to={`/p/${projectKey}/settings/integrator#operator-grant`}>
            {t('inbox.handedOff.grant')}
          </ButtonLink>
        ) : null
      ) : null}
      {handoff.reason === 'processing_failed' && cardHref ? (
        <ButtonLink variant="primary" to={cardHref}>
          {t('inbox.handedOff.openCard')}
        </ButtonLink>
      ) : null}
    </div>
  );
}
