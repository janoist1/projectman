import clsx from 'clsx';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Link } from 'react-router';
import { releaseApprovalOf } from '@projectman/shared';
import type { InboxItem, ReleaseFailedAlert, ResolveInboxRequest } from '@projectman/shared';
import { useBoard, useConfig } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Fold } from '../../components/Fold';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { t } from '../../i18n/t';
import { releaseChangesUrl, releaseFailedWords, releaseGithub } from '../../lib/release';
import { shortCommit } from '../../lib/timeline';
import styles from './InboxCard.module.css';
import releaseStyles from './ReleaseInbox.module.css';

/** At most this many cards of the release are listed before the toggle. */
const CARDS_SHOWN = 6;

/** The release card as the board knows it, and the configuration for its repository. */
function useReleaseFacts(taskKey: string | null) {
  const { key, can } = useProject();
  const board = useBoard(key);
  const config = useConfig(key, can.readConfig).data?.config;
  const task = taskKey ? board.data?.tasks.find((entry) => entry.key === taskKey) : undefined;
  return { projectKey: key, task, config };
}

/** `KEY cím` of the release card, a link to it; a card the board no longer lists shows the fallback title, else its key only. */
export function ReleaseCardLink({ taskKey, fallback }: { taskKey: string; fallback?: string }) {
  const { projectKey, task } = useReleaseFacts(taskKey);
  return (
    <Link to={`/p/${projectKey}/tasks/${taskKey}`}>
      <span className={releaseStyles.key}>{taskKey}</span>
      {task?.title ?? fallback ?? ''}
    </Link>
  );
}

/** What a decided release shows in the list of decisions: the release card, linked. */
export function ReleaseSubject({ taskKey, title }: { taskKey: string; title?: string }) {
  return (
    <span className={releaseStyles.cardLine}>
      <ReleaseCardLink taskKey={taskKey} fallback={title} />
    </span>
  );
}

function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      className={releaseStyles.external}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${label} ${t('inbox.release.newTab')}`}
    >
      {label} <span aria-hidden="true">↗</span>
    </a>
  );
}

function Commit({ commit }: { commit: string }) {
  return <code title={commit}>{shortCommit(commit)}</code>;
}

/** Whether the element's content is taller than the box it is cut to. */
export function useOverflowing(ref: RefObject<HTMLElement | null>, text: string, open: boolean): boolean {
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const measure = () => {
      const element = ref.current;
      if (element) setOverflowing(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ref, text, open]);
  return overflowing;
}

function Summary({ text }: { text: string }) {
  const labelId = useId();
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const measured = useOverflowing(box, text, open);
  // Opened, the box has no limit to measure: the toggle stays so the text can be closed again.
  const needed = measured || open;
  return (
    <>
      <p id={labelId} className={releaseStyles.sectionLabel}>
        {t('inbox.release.summary')} <span>{t('inbox.release.summaryHint')}</span>
      </p>
      <div
        ref={box}
        id={bodyId}
        role="group"
        aria-labelledby={labelId}
        className={clsx(
          releaseStyles.summary,
          !open && releaseStyles.summaryClosed,
          !open && measured && releaseStyles.cut,
        )}
      >
        <Markdown text={text} />
      </div>
      {needed ? (
        <button
          type="button"
          className={releaseStyles.more}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          {open ? t('inbox.release.less') : t('inbox.release.summaryMore')}{' '}
          <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
      ) : null}
    </>
  );
}

function Cards({ tasks }: { tasks: readonly { key: string; title: string }[] }) {
  const { key: projectKey } = useProject();
  const labelId = useId();
  const listId = useId();
  const [all, setAll] = useState(false);
  const shown = all ? tasks : tasks.slice(0, CARDS_SHOWN);
  const hidden = tasks.length - CARDS_SHOWN;
  return (
    <>
      <p id={labelId} className={releaseStyles.sectionLabel}>
        {t('inbox.release.cards', { count: tasks.length })}
      </p>
      <ul id={listId} className={releaseStyles.cards} aria-labelledby={labelId}>
        {shown.map((task) => (
          <li key={task.key}>
            <Link to={`/p/${projectKey}/tasks/${task.key}`}>
              <span className={releaseStyles.key}>{task.key}</span>
              <span className={releaseStyles.title}>{task.title === task.key ? '' : task.title}</span>
            </Link>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button
          type="button"
          className={releaseStyles.more}
          aria-expanded={all}
          aria-controls={listId}
          onClick={() => setAll(!all)}
        >
          {all ? t('inbox.release.less') : t('inbox.release.cardsMore', { count: hidden })}{' '}
          <span aria-hidden="true">{all ? '▴' : '▾'}</span>
        </button>
      ) : null}
    </>
  );
}

/**
 * What a release item tells under its heading (PM-492): what approving does, which versions, the
 * English summary of the GitHub release and the cards in it.
 */
export function ReleaseInboxBody({ item }: { item: InboxItem }) {
  const release = releaseApprovalOf(item);
  const { task, config } = useReleaseFacts(item.taskKey);
  if (!release) return null;
  const github = releaseGithub(config, task?.repo);
  const url = github ? releaseChangesUrl(github, release.commit, release.baseCommit) : null;
  return (
    <>
      <p className={styles.body}>{t('inbox.release.lead')}</p>
      <div className={releaseStyles.version}>
        <span>{t('inbox.release.version')}</span>
        {release.baseCommit ? (
          <>
            <span className={releaseStyles.srOnly}>
              {t('inbox.release.versionRange', {
                base: shortCommit(release.baseCommit),
                commit: shortCommit(release.commit),
              })}
            </span>
            <span aria-hidden="true">
              <Commit commit={release.baseCommit} /> → <Commit commit={release.commit} />
            </span>
          </>
        ) : (
          <>
            <Commit commit={release.commit} />
            <span>· {t('inbox.release.firstVersion')}</span>
          </>
        )}
        {url ? (
          <ExternalLink
            href={url}
            label={t(release.baseCommit ? 'inbox.release.compare' : 'inbox.release.commitLink')}
          />
        ) : null}
      </div>
      <Summary text={release.summary} />
      <Cards tasks={release.tasks} />
    </>
  );
}

/** The words of an approve / reject row; a release says them one way, an e-mail another (PM-942). */
export interface ApprovalWords {
  approve: string;
  reject: string;
  rejectLabel: string;
  rejectOptional: string;
  rejectPlaceholder: string;
  rejectCancel: string;
}

const releaseWords = (): ApprovalWords => ({
  approve: t('inbox.options.approve'),
  reject: t('inbox.options.reject'),
  rejectLabel: t('inbox.release.rejectLabel'),
  rejectOptional: t('inbox.release.rejectOptional'),
  rejectPlaceholder: t('inbox.release.rejectPlaceholder'),
  rejectCancel: t('inbox.release.rejectCancel'),
});

/**
 * The buttons of a release item: "Jóváhagyom", and "Elutasítom", which opens a box for the optional
 * reason in place of the row. An e-mail approval uses the same row with its own words.
 */
export function ReleaseInboxActions({
  item,
  size,
  pending,
  detailsHref,
  onResolve,
  words = releaseWords(),
}: {
  item: InboxItem;
  size: 'lg' | 'xl';
  pending: boolean;
  detailsHref?: string | null;
  onResolve: (item: InboxItem, body: ResolveInboxRequest) => void;
  words?: ApprovalWords;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [chosen, setChosen] = useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const rejectOpen = useRef<HTMLButtonElement>(null);
  const noteId = useId();
  const opened = useRef(false);
  useEffect(() => {
    if (rejecting) field.current?.focus();
    else if (opened.current) rejectOpen.current?.focus();
    opened.current = rejecting;
  }, [rejecting]);

  const decide = (optionId: 'approve' | 'reject') => {
    setChosen(optionId);
    const reason = note.trim();
    onResolve(item, { optionId, ...(optionId === 'reject' && reason ? { note: reason } : {}) });
  };

  if (rejecting)
    return (
      <>
        <div className={releaseStyles.reject}>
          <label htmlFor={noteId} className={releaseStyles.rejectLabel}>
            {words.rejectLabel} <span>{words.rejectOptional}</span>
          </label>
          <textarea
            id={noteId}
            ref={field}
            className={releaseStyles.rejectInput}
            rows={2}
            value={note}
            placeholder={words.rejectPlaceholder}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setRejecting(false);
              } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !pending) {
                decide('reject');
              }
            }}
          />
        </div>
        <div className={releaseStyles.actions}>
          <Button
            variant="dangerSolid"
            size={size}
            loading={pending && chosen === 'reject'}
            disabled={pending}
            onClick={() => decide('reject')}
          >
            {words.reject}
          </Button>
          <Button variant="ghost" size={size} disabled={pending} onClick={() => setRejecting(false)}>
            {words.rejectCancel}
          </Button>
        </div>
      </>
    );
  return (
    <div className={releaseStyles.actions}>
      <Button
        variant="primary"
        size={size}
        loading={pending && chosen === 'approve'}
        disabled={pending}
        onClick={() => decide('approve')}
      >
        {words.approve}
      </Button>
      <Button
        ref={rejectOpen}
        variant="danger"
        size={size}
        disabled={pending}
        onClick={() => setRejecting(true)}
      >
        {words.reject}
      </Button>
      {detailsHref && size !== 'xl' ? (
        <>
          <span className={releaseStyles.spacer} />
          <Link to={detailsHref} className={styles.details}>
            <span>{t('inbox.details')}</span>
            <Icon name="arrowRight" size={14} strokeWidth={2.2} />
          </Link>
        </>
      ) : null}
    </div>
  );
}

/** Whether the release alert is the one that needs the owner's hands: the old version does not run either. */
export function isReleaseDown(alert: ReleaseFailedAlert): boolean {
  return releaseFailedWords(alert.step, alert.rolledBack, alert.taskKey).outcome === 'down';
}

/** What a `release_failed` alert tells: where it stopped, what became of the old version, what comes next. */
export function ReleaseAlertBody({ alert }: { alert: ReleaseFailedAlert }) {
  const words = releaseFailedWords(alert.step, alert.rolledBack, alert.taskKey);
  return (
    <>
      <p className={styles.body}>{words.what}</p>
      <p className={styles.body}>{words.next}</p>
      {alert.message ? (
        <Fold summary={t('inbox.alerts.release_failed.details')}>
          <pre className={releaseStyles.output}>{alert.message}</pre>
        </Fold>
      ) : null}
    </>
  );
}
