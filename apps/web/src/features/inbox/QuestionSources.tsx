import { Fragment } from 'react';
import { Link } from 'react-router';
import type { QuestionGroup } from '@projectman/shared';
import { Avatar } from '../../components/Avatar';
import { Chip } from '../../components/Chip';
import { Fold } from '../../components/Fold';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import styles from './QuestionSources.module.css';

export function generalQuestionSources(group: QuestionGroup) {
  return (group.sources ?? []).filter((source) => source.taskKey === null && source.question !== null);
}

export function QuestionSourcesLine({ group, projectKey }: { group: QuestionGroup; projectKey: string }) {
  const general = generalQuestionSources(group);
  const sources = (group.sources ?? []).filter((source) => !general.includes(source));
  const cards = sources.filter(
    (source, index) => !source.taskKey || sources.findIndex((s) => s.taskKey === source.taskKey) === index,
  );
  return (
    <p className={styles.line}>
      <span>
        {t(general.length ? 'inbox.group.lineMixed' : 'inbox.group.line', {
          count: cards.length + general.length,
        })}
      </span>{' '}
      {cards.map((source, index) => (
        <Fragment key={source.itemId}>
          {index ? ' · ' : ''}
          {source.taskKey ? (
            <Link
              to={`/p/${projectKey}/tasks/${source.taskKey}`}
              aria-label={t('inbox.group.openKey', { key: source.taskKey })}
            >
              {source.taskKey}
            </Link>
          ) : (
            t(source.state === 'deleted' ? 'inbox.group.deletedCard' : 'inbox.group.hiddenCard')
          )}
        </Fragment>
      ))}
      {general.length ? (
        <>
          {cards.length ? ' · ' : ''}
          <span>{t('inbox.group.generalCount', { count: general.length })}</span>
        </>
      ) : null}
    </p>
  );
}

export function QuestionSources({
  group,
  projectKey,
  members,
  myHandle,
}: {
  group: QuestionGroup;
  projectKey: string;
  members: MemberIndex;
  myHandle: string | null;
}) {
  const general = generalQuestionSources(group);
  return (
    <Fold summary={t('inbox.group.sources', { count: group.sources?.length ?? group.itemIds.length })}>
      <ul className={styles.sources}>
        {(group.sources ?? []).map((source) => (
          <li key={source.itemId} className={source.state === 'withdrawn' ? styles.withdrawn : undefined}>
            <Avatar member={members.get(source.asker)} handle={source.asker} size="sm" />
            <div className={styles.source}>
              {source.taskKey ? (
                <Link className={styles.cardLink} to={`/p/${projectKey}/tasks/${source.taskKey}`}>
                  <span className={styles.key}>{source.taskKey}</span>
                  {source.taskTitle ? ` ${source.taskTitle}` : ''}
                </Link>
              ) : general.includes(source) ? (
                <p className={styles.general}>{t('inbox.group.sourceGeneral')}</p>
              ) : (
                <p>
                  {t(source.state === 'deleted' ? 'inbox.group.sourceDeleted' : 'inbox.group.sourceHidden')}
                </p>
              )}
              <p className={styles.meta}>
                {nameOf(source.asker, members, myHandle)} ·{' '}
                <time dateTime={source.createdAt}>{formatAgo(source.createdAt)}</time>
              </p>
              {source.state === 'withdrawn' ? <Chip tone="neutral">{t('inbox.group.withdrawn')}</Chip> : null}
              {source.question ? <p className={styles.question}>{source.question}</p> : null}
            </div>
          </li>
        ))}
      </ul>
    </Fold>
  );
}
