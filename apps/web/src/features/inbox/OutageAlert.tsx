import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { InboxItem, WorkOutage, WorkOutageAlert } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { useBoard, useCheckOutage } from '../../api/queries';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { outageBody, outageFixText, outageTodo } from '../../lib/outage';
import styles from './OutageAlert.module.css';

const COPIED_MS = 1500;
/** How many chips are shown before "+N további": the desktop and the phone. */
const MEMBER_LIMIT = { desktop: 5, mobile: 3 } as const;
const CARD_LIMIT = { desktop: 6, mobile: 4 } as const;

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className={styles.command}>
      <code className={styles.commandText}>{command}</code>
      <Button
        variant="secondary"
        size="md"
        aria-label={t('inbox.alerts.work_outage.todo.copyLabel', { command })}
        onClick={() => {
          void navigator.clipboard.writeText(command).then(
            () => setCopied(true),
            () => {},
          );
        }}
      >
        {t('inbox.alerts.work_outage.todo.copy')}
      </Button>
      <span role="status" className={styles.copied}>
        {copied ? t('inbox.alerts.work_outage.todo.copied') : ''}
      </span>
    </div>
  );
}

/** What to do: the login command with a Copy button, a link to the settings, or the engine's way back. */
export function Todo({ outage, projectKey }: { outage: WorkOutage; projectKey: string }) {
  const todo = outageTodo(outage);
  const prefix = 'inbox.alerts.work_outage.todo';
  let line: string;
  let extra: ReactNode = null;
  switch (todo.kind) {
    case 'login': {
      const provider = outage.kind === 'provider' ? t(`providers.${outage.provider}`) : '';
      line = todo.engine
        ? t(todo.install ? `${prefix}.installOnEngine` : `${prefix}.loginOnEngine`, {
            engine: todo.engine,
            provider,
          })
        : t(todo.install ? `${prefix}.install` : `${prefix}.login`, { provider });
      extra = <CopyCommand command={todo.command} />;
      break;
    }
    case 'fix':
      line = outageFixText(todo);
      if (todo.problem === 'chatgpt_login')
        extra = (
          <div className={styles.command}>
            <code className={styles.commandText}>providers/nanogpt/codex-home/auth.json</code>
          </div>
        );
      break;
    case 'settings':
      line = t(`${prefix}.settings`);
      extra = (
        <Link to={`/p/${projectKey}/settings/providers`} className={styles.todoLink}>
          {t(`${prefix}.openSettings`)}
        </Link>
      );
      break;
    case 'engine':
      line = t(`${prefix}.engine`);
      extra = (
        <Link to={`/p/${projectKey}/settings/engines`} className={styles.todoLink}>
          {t(`${prefix}.manage`)}
        </Link>
      );
      break;
  }
  return (
    <div className={styles.todo}>
      <span className={styles.todoLabel}>{t(`${prefix}.label`)}</span>
      <p className={styles.todoText}>{line}</p>
      {extra}
    </div>
  );
}

/** A row of chips cut at `limit`, the rest behind "+N további" that opens them in place. */
function ChipList<T>({
  items,
  limit,
  render,
  moreLabel,
}: {
  items: readonly T[];
  limit: number;
  render: (item: T) => ReactNode;
  moreLabel: (count: number) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const firstNew = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (expanded) firstNew.current?.querySelector<HTMLElement>('a')?.focus();
  }, [expanded]);
  const hidden = items.length - limit;
  const shown = expanded || hidden <= 0 ? items : items.slice(0, limit);
  return (
    <ul className={styles.chips}>
      {shown.map((item, index) => (
        <li key={index} ref={index === limit ? firstNew : undefined}>
          {render(item)}
        </li>
      ))}
      {!expanded && hidden > 0 ? (
        <li>
          <button
            type="button"
            className={styles.more}
            aria-label={moreLabel(hidden)}
            onClick={() => setExpanded(true)}
          >
            {t('inbox.alerts.work_outage.affected.more', { count: hidden })}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

/** Who cannot work and which cards wait because of it (the item's lists follow the day). */
function Affected({
  alert,
  members,
  myHandle,
  mobile,
}: {
  alert: WorkOutageAlert;
  members: MemberIndex;
  myHandle: string | null;
  mobile: boolean;
}) {
  const { key } = useProject();
  const board = useBoard(key);
  const titles = new Map((board.data?.tasks ?? []).map((task) => [task.key, task.title]));
  const prefix = 'inbox.alerts.work_outage.affected';
  const size = mobile ? 'mobile' : 'desktop';
  return (
    <dl className={styles.affected}>
      {alert.members.length > 0 ? (
        <div className={styles.affectedRow}>
          <dt>{t(`${prefix}.members`, { count: alert.members.length })}</dt>
          <dd>
            <ChipList
              items={alert.members}
              limit={MEMBER_LIMIT[size]}
              moreLabel={(count) => t(`${prefix}.moreMembersLabel`, { count })}
              render={(handle) => (
                <Link to={`/p/${key}/team/${handle}`} className={styles.chip}>
                  <Avatar member={members.get(handle)} handle={handle} size="xs" />
                  <span>{nameOf(handle, members, myHandle)}</span>
                </Link>
              )}
            />
          </dd>
        </div>
      ) : null}
      <div className={styles.affectedRow}>
        <dt>{t(`${prefix}.cards`, { count: alert.tasks.length })}</dt>
        <dd>
          {alert.tasks.length === 0 ? (
            <span className={styles.empty}>{t(`${prefix}.noCards`)}</span>
          ) : (
            <ChipList
              items={alert.tasks}
              limit={CARD_LIMIT[size]}
              moreLabel={(count) => t(`${prefix}.moreCardsLabel`, { count })}
              render={(taskKey) => {
                const label = t(`${prefix}.openCard`, { key: taskKey, title: titles.get(taskKey) ?? '' });
                return (
                  <Link
                    to={`/p/${key}/tasks/${taskKey}`}
                    className={`${styles.chip} ${styles.cardChip}`}
                    title={label}
                    aria-label={label}
                  >
                    {taskKey}
                  </Link>
                );
              }}
            />
          )}
        </dd>
      </div>
    </dl>
  );
}

/** The body of a `work_outage` alert: what it stops, what to do, who and what waits, and that it closes by itself. */
export function OutageAlert({
  alert,
  members,
  myHandle,
  mobile,
}: {
  alert: WorkOutageAlert;
  members: MemberIndex;
  myHandle: string | null;
  mobile: boolean;
}) {
  const { key } = useProject();
  return (
    <div className={styles.outage}>
      <p className={styles.body}>{outageBody(alert.outage)}</p>
      <Todo outage={alert.outage} projectKey={key} />
      <Affected alert={alert} members={members} myHandle={myHandle} mobile={mobile} />
      <p className={styles.footer}>{t('inbox.alerts.work_outage.selfClosing')}</p>
    </div>
  );
}

/** "Check now": the server looks again; the answer is that the item goes, or that it still stands. */
export function OutageCheck({ item, size }: { item: InboxItem; size: 'lg' | 'xl' }) {
  const { key } = useProject();
  const check = useCheckOutage(key);
  const toast = useToast();
  const [stillFailing, setStillFailing] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        size={size}
        disabled={check.isPending}
        onClick={() => {
          setStillFailing(false);
          check.mutate(item.id, {
            onSuccess: (response) => setStillFailing(response.stillFailing),
            onError: (error) => toast.show(errorMessage(error), 'error'),
          });
        }}
      >
        {t('inbox.alerts.work_outage.checkNow')}
      </Button>
      <span role="status" aria-live="polite" className={styles.checkResult}>
        {check.isPending
          ? t('inbox.alerts.work_outage.checking')
          : stillFailing
            ? t('inbox.alerts.work_outage.stillFailing')
            : ''}
      </span>
    </>
  );
}
