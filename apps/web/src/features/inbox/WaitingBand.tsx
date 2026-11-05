import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { screeningWaitingSince } from '@projectman/shared';
import type { InboxItem, WaitingForOthers } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { usePullWaitingQuestion } from '../../api/queries';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toastContext';
import { formatWaitAge } from '../../i18n/format';
import { t } from '../../i18n/t';
import { decisionSubject, inboxItemDomId, screeningOf, waitingNote } from '../../lib/inbox';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import styles from './WaitingBand.module.css';

/** After this long a wait reads as late: the age turns bold and `needs`-coloured. */
const LATE_AFTER_MS = 24 * 60 * 60 * 1000;
/** How long a pulled row fades out before it leaves the band. */
const FADE_MS = 160;

type Attempt = { item: InboxItem; status: 'busy' | 'leaving' | 'handled' | 'failed' };

function sentence(waiting: WaitingForOthers): string {
  const screening = waiting.screening.count;
  const integrator = waiting.integrator.count;
  if (screening > 0 && integrator > 0) return t('inbox.waiting.both', { screening, integrator });
  if (screening > 0) return t('inbox.waiting.onlyScreening', { count: screening });
  return t('inbox.waiting.onlyIntegrator', { count: integrator });
}

/** The band's one line: what waits, and (turning bold once it is late) how long the oldest has. */
function Headline({ text, oldest, late }: { text: string; oldest: string | null; late: boolean }) {
  return (
    <span className={styles.sentence}>
      {text}
      {oldest ? (
        <>
          {' · '}
          <span className={clsx(late && styles.late)}>{t('inbox.waiting.oldest', { age: oldest })}</span>
        </>
      ) : null}
    </span>
  );
}

function oldestOf(waiting: WaitingForOthers): string | null {
  const times = [waiting.screening.oldestAt, waiting.integrator.oldestAt].filter(
    (value): value is string => value !== null,
  );
  return times.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}

function WaitingRow({
  item,
  status,
  members,
  myHandle,
  taskHref,
  onPull,
}: {
  item: InboxItem;
  status: Attempt['status'] | 'idle';
  members: MemberIndex;
  myHandle: string | null;
  taskHref: string | null;
  onPull: (item: InboxItem) => void;
}) {
  const overdue = screeningOf(item)?.waiting?.overdue === true;
  const subject = decisionSubject(item);
  const row = useRef<HTMLLIElement>(null);
  const pullButton = useRef<HTMLButtonElement>(null);
  const handledNote = useRef<HTMLSpanElement>(null);
  // The pull button disables while it works, which drops the focus onto the page: put it back where the
  // keyboard user can go on, on the button after a failure and on the answer when it was handled meanwhile.
  useEffect(() => {
    if (status !== 'failed' && status !== 'handled') return;
    const active = document.activeElement;
    if (active && active !== document.body && !row.current?.contains(active)) return;
    (status === 'failed' ? pullButton : handledNote).current?.focus();
  }, [status]);
  return (
    <li ref={row} className={clsx(styles.item, status === 'leaving' && styles.leaving)}>
      <span className={styles.text}>
        <span className={styles.line}>
          {status === 'handled' ? null : (
            <Chip tone={overdue ? 'needs' : 'neutral'} size="sm">
              {t(overdue ? 'inbox.waiting.overdue' : 'inbox.waiting.chip')}
            </Chip>
          )}
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
        <span className={styles.subject}>{subject}</span>
        {status === 'handled' ? (
          <span ref={handledNote} className={styles.note} role="status" tabIndex={-1}>
            {t('inbox.waiting.alreadyHandled')}
          </span>
        ) : (
          <span className={styles.note}>{waitingNote(item)}</span>
        )}
        {status === 'failed' ? (
          <span className={styles.failure} role="alert">
            {t('inbox.waiting.pullFailed')}
          </span>
        ) : null}
      </span>
      {status === 'handled' ? null : (
        <Button
          ref={pullButton}
          variant="secondary"
          size="md"
          className={styles.pull}
          loading={status === 'busy' || status === 'leaving'}
          aria-label={t('inbox.waiting.pullFor', { subject })}
          onClick={() => onPull(item)}
        >
          {t(status === 'busy' ? 'inbox.waiting.pulling' : 'inbox.waiting.pull')}
        </Button>
      )}
    </li>
  );
}

/**
 * "Másokra vár" (PM-1252): a quiet, folded band above the owner's list that says what waits for someone other than
 * the owner: questions the project manager has not screened yet (each can be taken over) and open todos of the
 * connected Claude. It is no inbox item and it is not counted anywhere.
 */
export function WaitingBand({
  projectKey,
  waiting,
  items,
  members,
  myHandle,
  taskHrefOf,
}: {
  projectKey: string;
  waiting: WaitingForOthers | undefined;
  items: readonly InboxItem[];
  members: MemberIndex;
  myHandle: string | null;
  taskHrefOf: (item: InboxItem) => string | null;
}) {
  const pull = usePullWaitingQuestion(projectKey);
  const toast = useToast();
  const [attempts, setAttempts] = useState<Record<string, Attempt>>({});
  const timers = useRef<number[]>([]);
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const settle = (item: InboxItem, status: Attempt['status']) =>
    setAttempts((current) => ({ ...current, [item.id]: { item, status } }));
  const forget = (id: string) =>
    setAttempts((current) => {
      const { [id]: _gone, ...rest } = current;
      return rest;
    });

  const onPull = (item: InboxItem) => {
    settle(item, 'busy');
    pull.mutate(item.id, {
      onSuccess: () => {
        settle(item, 'leaving');
        toast.show(t('inbox.waiting.pulled'), 'ok');
        timers.current.push(
          window.setTimeout(() => {
            forget(item.id);
            document
              .getElementById(inboxItemDomId(item.id))
              ?.querySelector<HTMLElement>('[data-inbox-title]')
              ?.focus();
          }, FADE_MS),
        );
      },
      onError: (error) =>
        settle(
          item,
          isApiError(error) && (error.status === 409 || error.status === 404) ? 'handled' : 'failed',
        ),
    });
  };

  // The rows: what still waits (oldest first) and the rows of this session's pulls that must keep their say.
  const waitingItems = items
    .filter((item) => screeningWaitingSince(item) !== null)
    .sort((a, b) => Date.parse(screeningWaitingSince(a)!) - Date.parse(screeningWaitingSince(b)!));
  const stillWaiting = new Set(waitingItems.map((item) => item.id));
  const rows = [
    ...waitingItems.map((item) => ({ item, status: attempts[item.id]?.status ?? ('idle' as const) })),
    ...Object.values(attempts)
      .filter((attempt) => !stillWaiting.has(attempt.item.id))
      .map((attempt) => ({ item: attempt.item, status: attempt.status })),
  ];

  const total = (waiting?.screening.count ?? 0) + (waiting?.integrator.count ?? 0);
  if (!waiting || (total === 0 && rows.length === 0)) return null;

  const oldest = total > 0 ? oldestOf(waiting) : null;
  const late = oldest !== null && Date.now() - Date.parse(oldest) >= LATE_AFTER_MS;
  // With nothing waiting any more, only this session's answers ("already handled") keep the band.
  const headline = (
    <Headline
      text={oldest ? sentence(waiting) : t('inbox.waiting.title')}
      oldest={oldest ? formatWaitAge(oldest) : null}
      late={late}
    />
  );

  // Only machine todos wait: nothing to take over, so a plain row that does not open.
  if (waiting.screening.count === 0 && rows.length === 0) {
    return (
      <section className={styles.band} aria-label={t('inbox.waiting.title')}>
        <p className={styles.plain}>
          <Icon name="clock" size={16} className={styles.icon} />
          {headline}
        </p>
      </section>
    );
  }

  return (
    <section className={styles.band} aria-label={t('inbox.waiting.title')}>
      <details className={styles.fold}>
        <summary className={styles.summary}>
          <Icon name="clock" size={16} className={styles.icon} />
          {headline}
          <span className={styles.cue} aria-hidden="true">
            <span className={styles.cueOpen}>{t('inbox.waiting.show')}</span>
            <span className={styles.cueClose}>{t('inbox.waiting.hide')}</span>
          </span>
        </summary>
        <p className={styles.lead}>{t('inbox.waiting.lead')}</p>
        <ul className={styles.list}>
          {rows.map(({ item, status }) => (
            <WaitingRow
              key={item.id}
              item={item}
              status={status}
              members={members}
              myHandle={myHandle}
              taskHref={taskHrefOf(item)}
              onPull={onPull}
            />
          ))}
        </ul>
      </details>
    </section>
  );
}
