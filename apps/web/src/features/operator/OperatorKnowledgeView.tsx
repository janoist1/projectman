import { Fragment, useState } from 'react';
import type { OperatorPreferenceData } from '@projectman/shared';
import { operatorKnowledgeApprovalOf } from '@projectman/shared';
import { Link } from 'react-router';
import { useConfig, useInbox } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Fold } from '../../components/Fold';
import { ErrorState } from '../../components/States';
import { formatStamp } from '../../i18n/format';
import { t, tDynamic } from '../../i18n/t';
import { inboxItemDomId } from '../../lib/inbox';
import { OperatorWaiver } from './OperatorWaiver';
import { useOperatorKnowledge } from './useOperatorKnowledge';
import styles from './OperatorKnowledge.module.css';

export function KnowledgeSummary({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <p className={`${styles.summary} ${expanded ? '' : styles.clamped}`}>{text}</p>
      <Button variant="ghost" size="md" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {t(expanded ? 'knowledge.less' : 'knowledge.more')}
      </Button>
    </div>
  );
}

export function KnowledgeSkeleton() {
  return (
    <div className={`${styles.section} ${styles.skeleton}`} role="status" aria-label={t('app.loading')}>
      <span />
      <span />
      <span />
    </div>
  );
}

const fields = ['length', 'technicalLevel', 'detail', 'clarity', 'background'] as const;
function preferenceValues(data: OperatorPreferenceData) {
  return fields.map((field) => tDynamic(`knowledge.values.${field}.${data[field]}`, data[field]));
}

export function OperatorKnowledgeView({
  onBack,
  onPrefill,
}: {
  onBack: () => void;
  onPrefill: (text: string) => void;
}) {
  const { key, myHandle, isOwner } = useProject();
  const { members } = useProjectIndexes(key);
  const { knowledge, preference, preferences, readable } = useOperatorKnowledge();
  const config = useConfig(key, readable);
  const inbox = useInbox(key);
  const proposals =
    inbox.data?.items.filter(
      (item) =>
        item.state === 'open' && item.assignees.includes(myHandle ?? '') && operatorKnowledgeApprovalOf(item),
    ) ?? [];
  const agreement = knowledge.data?.agreement;
  const others =
    preferences.data?.items.filter((item) => item.handle !== myHandle && item.preference.revision > 0) ?? [];
  return (
    <div className={styles.view}>
      <Button variant="ghost" size="lg" onClick={onBack}>
        {t('knowledge.back')}
      </Button>
      <h3>{t(readable ? 'knowledge.title' : 'knowledge.style')}</h3>
      {isOwner && proposals.length > 0 ? (
        <div className={styles.alert}>
          {t('knowledge.waiting', { count: proposals.length })}{' '}
          <Link to={`/p/${key}/inbox#${inboxItemDomId(proposals[0]!.id)}`}>{t('knowledge.see')}</Link>
        </div>
      ) : null}
      {readable ? (
        knowledge.isPending ? (
          <KnowledgeSkeleton />
        ) : knowledge.isError ? (
          <ErrorState
            compact
            error={knowledge.error}
            message={t('knowledge.failed')}
            onRetry={() => void knowledge.refetch()}
          />
        ) : (
          <>
            <section className={styles.section}>
              <h4>{t('knowledge.agreement')}</h4>
              {agreement ? (
                <>
                  <span className={styles.chip}>
                    {t(`knowledge.involvement.${agreement.data.involvement}`)}
                  </span>
                  <KnowledgeSummary text={agreement.data.summary} />
                  {agreement.data.extraCritical.length > 0 ? (
                    <div>
                      {t('knowledge.critical')}
                      <ul>
                        {agreement.data.extraCritical.map((text, index) => (
                          <li key={index}>{text}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <p className={styles.meta}>
                    {isOwner
                      ? t('knowledge.approved', {
                          version: agreement.version,
                          date: formatStamp(agreement.approvedAt),
                        })
                      : t('knowledge.approvedOther', {
                          version: agreement.version,
                          name: members.get(agreement.approvedBy)?.displayName ?? agreement.approvedBy,
                          date: formatStamp(agreement.approvedAt),
                        })}
                  </p>
                  {isOwner ? (
                    <Button variant="ghost" onClick={() => onPrefill(t('knowledge.editPrompt'))}>
                      {t('knowledge.edit')}
                    </Button>
                  ) : (
                    <p className={styles.meta}>{t('knowledge.adminEdit')}</p>
                  )}
                </>
              ) : (
                <>
                  <p>{t(isOwner ? 'knowledge.emptyOwner' : 'knowledge.emptyAdmin')}</p>
                  {isOwner ? (
                    <Button variant="ghost" onClick={() => onPrefill(t('knowledge.startPrompt'))}>
                      {t('knowledge.start')}
                    </Button>
                  ) : null}
                </>
              )}
            </section>
            {config.isPending ? (
              <KnowledgeSkeleton />
            ) : config.isError ? (
              <ErrorState compact error={config.error} onRetry={() => void config.refetch()} />
            ) : config.data ? (
              <OperatorWaiver config={config.data} agreementVersion={agreement?.version ?? null} />
            ) : null}
            <section className={styles.section}>
              <h4>{t('knowledge.principles', { count: knowledge.data.principles.length })}</h4>
              {knowledge.data.principles.length === 0 ? (
                <p>{t('knowledge.emptyPrinciples')}</p>
              ) : (
                knowledge.data.principles.map((principle) => (
                  <div key={principle.id} className={styles.section}>
                    <strong>{principle.principle}</strong>
                    <p>{t('knowledge.effect', { effect: principle.effect })}</p>
                    <Fold summary={t('knowledge.example')}>{principle.example}</Fold>
                    {isOwner ? (
                      <div className={styles.actions}>
                        {(['rewrite', 'remove'] as const).map((action) => (
                          <Button
                            key={action}
                            variant="ghost"
                            onClick={() =>
                              onPrefill(
                                t(`knowledge.${action}Prompt`, {
                                  principle:
                                    principle.principle.length > 80
                                      ? `${principle.principle.slice(0, 80)}…`
                                      : principle.principle,
                                }),
                              )
                            }
                          >
                            {t(`knowledge.${action}`)}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </section>
          </>
        )
      ) : null}
      {preference.isPending ? (
        <KnowledgeSkeleton />
      ) : preference.isError ? (
        <ErrorState
          compact
          error={preference.error}
          message={t('knowledge.failed')}
          onRetry={() => void preference.refetch()}
        />
      ) : (
        <section className={styles.section}>
          <h4>{t('knowledge.style')}</h4>
          <dl className={styles.style}>
            {fields.map((field, index) => (
              <Fragment key={field}>
                <dt>{t(`knowledge.fields.${field}`)}</dt>
                <dd>{preferenceValues(preference.data.data)[index]}</dd>
              </Fragment>
            ))}
          </dl>
          {preference.data.revision === 0 ? (
            <p className={styles.meta}>{t('knowledge.defaultStyle')}</p>
          ) : null}
          <Button variant="ghost" onClick={() => onPrefill(t('knowledge.stylePrompt'))}>
            {t('knowledge.styleEdit')}
          </Button>
          {readable ? (
            <Fold summary={t('knowledge.others', { count: others.length })}>
              {preferences.isPending ? (
                <KnowledgeSkeleton />
              ) : preferences.isError ? (
                <ErrorState compact error={preferences.error} onRetry={() => void preferences.refetch()} />
              ) : others.length === 0 ? (
                <p>{t('knowledge.emptyOthers')}</p>
              ) : (
                others.map(({ handle, preference: other }) => (
                  <div key={handle} className={styles.person}>
                    <Avatar handle={handle} member={members.get(handle)} />
                    <div>
                      <strong>{members.get(handle)?.displayName ?? handle}</strong>
                      <p>{preferenceValues(other.data).join(' · ')}</p>
                    </div>
                  </div>
                ))
              )}
              <p className={styles.meta}>{t('knowledge.styleFoot')}</p>
            </Fold>
          ) : null}
        </section>
      )}
    </div>
  );
}
