import { useState } from 'react';
import { Link } from 'react-router';
import type { InboxItem } from '@projectman/shared';
import { useScreenedQuestions } from '../../api/queries';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import { decisionSubject, operatorTrailMark, operatorTrailNote } from '../../lib/inbox';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import styles from './OperatorTrail.module.css';

/** The start of the viewer's day as an ISO time: what "ma" counts from. */
function startOfToday(): string {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return day.toISOString();
}

function TrailRow({
  item,
  members,
  myHandle,
  taskHref,
}: {
  item: InboxItem;
  members: MemberIndex;
  myHandle: string | null;
  taskHref: string | null;
}) {
  const mark = operatorTrailMark(item);
  const note = operatorTrailNote(item);
  return (
    <li className={styles.item}>
      <span className={styles.icon} aria-hidden="true">
        <Icon name="minus" size={12} strokeWidth={3} />
      </span>
      <span className={styles.text}>
        <span className={styles.line}>
          <Chip tone={mark === 'at' ? 'accent' : 'neutral'} size="sm">
            {t(`inbox.operatorTrail.${mark}`)}
          </Chip>
          <span>{nameOf(item.source, members, myHandle)}</span>
          {item.taskKey ? (
            taskHref ? (
              <Link to={taskHref} className={styles.key}>
                {item.taskKey}
              </Link>
            ) : (
              <span className={styles.key}>{item.taskKey}</span>
            )
          ) : null}
        </span>
        <span className={styles.subject}>{decisionSubject(item)}</span>
        {note ? <span className={styles.note}>{note}</span> : null}
      </span>
    </li>
  );
}

/**
 * "Az Operátor intézte · ma N" (PM-556): a folded row of the questions the Operator settled with no person
 * involved, for owners and admins only. The list is read when the row opens; the count is read with the page.
 */
export function OperatorTrail({
  projectKey,
  members,
  myHandle,
  taskHrefOf,
}: {
  projectKey: string;
  members: MemberIndex;
  myHandle: string | null;
  taskHrefOf: (item: InboxItem) => string | null;
}) {
  const [since] = useState(startOfToday);
  const [opened, setOpened] = useState(false);
  const trail = useScreenedQuestions(projectKey, since, true);
  // Nothing to show while it loads, and nothing screened today: no empty row.
  if (trail.isPending) return null;
  const today = trail.data?.today ?? null;
  if (trail.data && today === 0) return null;
  const items = trail.data?.items ?? [];
  return (
    <section className={styles.trail} aria-label={t('inbox.operatorTrail.titleUnknown')}>
      <details
        className={styles.fold}
        onToggle={(event) => setOpened((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className={styles.summary}>
          {today === null
            ? t('inbox.operatorTrail.titleUnknown')
            : t('inbox.operatorTrail.title', { count: today })}
        </summary>
        <p className={styles.lead}>{t('inbox.operatorTrail.lead')}</p>
        {trail.isError && opened ? (
          <div className={styles.failed}>
            <p role="alert">{t('inbox.operatorTrail.error')}</p>
            <Button variant="ghost" onClick={() => void trail.refetch()}>
              {t('inbox.operatorTrail.retry')}
            </Button>
          </div>
        ) : (
          <>
            <ul className={styles.list}>
              {items.map((item) => (
                <TrailRow
                  key={item.id}
                  item={item}
                  members={members}
                  myHandle={myHandle}
                  taskHref={taskHrefOf(item)}
                />
              ))}
            </ul>
            {today !== null && today > items.length ? (
              <p className={styles.limit}>{t('inbox.operatorTrail.limit', { count: items.length })}</p>
            ) : null}
          </>
        )}
      </details>
    </section>
  );
}
