import { useEffect, useId, useRef, useState } from 'react';
import type { ConfigHistoryEntry, ConfigVersionEntry, MemberView } from '@projectman/shared';
import clsx from 'clsx';
import { HISTORY_HEAD_SIZE, useConfigHistory, useRevertConfig } from '../../../api/queries';
import { useProject, useProjectIndexes } from '../../../app/contexts';
import { ActorName } from '../../../components/ActorName';
import { Avatar } from '../../../components/Avatar';
import { Button } from '../../../components/Button';
import { Chip } from '../../../components/Chip';
import { Dialog } from '../../../components/Dialog';
import { ErrorBanner } from '../../../components/ErrorBanner';
import { MoreMenu } from '../../../components/MoreMenu';
import { ErrorState } from '../../../components/States';
import { useToast } from '../../../components/toastContext';
import { formatStamp } from '../../../i18n/format';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';
import type { MemberIndex } from '../../../lib/members';
import { actorLabel, distinctMembers, nameOf } from '../../../lib/members';
import shared from '../settings.module.css';
import styles from './HistorySection.module.css';
import { historyDetailLines, historySummary } from './historyText';
import { SettingsSection } from './SettingsSection';

/** Who a saved version is shown as: the project manager by name when it made the change, else the stored author. */
export function historyAuthorOf(
  entry: ConfigVersionEntry,
  members: MemberIndex,
  myHandle: string | null,
): string {
  if (entry.actor) return actorLabel(entry.actor, members, myHandle);
  if (entry.operator) return nameOf(entry.operator, members, myHandle);
  return entry.via ? t('involvement.integratorFull') : entry.author;
}

/**
 * The member an avatar shows for a version: the actor, then the project manager, then a member whose name is
 * the stored author's (only for the avatar, never for the attribution); none when that is not clear.
 */
function avatarMember(entry: ConfigVersionEntry, members: MemberIndex): MemberView | undefined {
  const handle = entry.actor?.handle ?? entry.operator;
  if (handle) return members.get(handle);
  if (entry.via) return undefined;
  const named = distinctMembers(members).filter((member) => member.displayName === entry.author);
  return named.length === 1 ? named[0] : undefined;
}

const SKELETON_ROWS = Array.from({ length: HISTORY_HEAD_SIZE }, (_, index) => index);

/** The saved configuration versions, newest first, each as a line of what changed; owners may restore one. */
export function HistorySection({ current, canRevert }: { current: string; canRevert: boolean }) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const history = useConfigHistory(key);
  const revert = useRevertConfig(key);
  const toast = useToast();
  const listId = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const [target, setTarget] = useState<ConfigHistoryEntry | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [refreshed, setRefreshed] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const focusRow = useRef<number | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const ownRevert = useRef(false);
  const lastCurrent = useRef(current);

  const entries = history.data?.pages.flatMap((page) => page.entries) ?? [];
  const total = history.data?.pages.at(-1)?.total ?? 0;

  // A save by someone else replaces the list with its first page; the note says why it moved.
  useEffect(() => {
    if (lastCurrent.current === current) return;
    lastCurrent.current = current;
    if (ownRevert.current) ownRevert.current = false;
    else setRefreshed(true);
  }, [current]);

  // After more rows came in, the keyboard lands on the first new one.
  useEffect(() => {
    const index = focusRow.current;
    if (index === null) return;
    focusRow.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-row="${index}"] [data-details]`)?.focus();
  }, [entries.length]);

  const toggle = (version: string) =>
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(version)) next.add(version);
      return next;
    });

  const loadMore = async () => {
    const before = entries.length;
    const result = await history.fetchNextPage();
    if (result.isError || !result.data) return;
    const after = result.data.pages.reduce((count, page) => count + page.entries.length, 0);
    focusRow.current = before;
    setAnnouncement(t('settings.history.loadedMore', { count: after - before }));
  };

  const closeDialog = () => {
    if (revert.isPending) return;
    revert.reset();
    setTarget(null);
  };

  // The row menu closes before the dialog opens, so the dialog is told where the focus returns.
  const askRestore = (entry: ConfigHistoryEntry, index: number) => {
    returnFocus.current =
      listRef.current?.querySelector<HTMLElement>(`[data-row="${index}"] [data-more] button`) ?? null;
    setTarget(entry);
  };

  const restore = () => {
    if (!target) return;
    ownRevert.current = true;
    revert.mutate(target.version, {
      onSuccess: () => {
        toast.show(t('settings.history.reverted'));
        returnFocus.current = document.getElementById('settings-history');
        setTarget(null);
      },
      onError: () => {
        ownRevert.current = false;
      },
    });
  };

  let body;
  if (history.isPending) {
    body = (
      <div className={styles.skeletons} aria-busy="true">
        <span className={styles.srOnly}>{t('settings.history.loading')}</span>
        {SKELETON_ROWS.map((index) => (
          <div key={index} className={styles.skeleton} aria-hidden="true" />
        ))}
      </div>
    );
  } else if (!history.data) {
    body = (
      <ErrorState
        error={history.error}
        message={t('settings.history.loadFailed')}
        onRetry={() => void history.refetch()}
      />
    );
  } else if (entries.length === 0) {
    body = <p className={shared.muted}>{t('settings.history.empty')}</p>;
  } else {
    body = (
      <>
        {history.isError && !history.isFetchNextPageError ? (
          <ErrorState
            compact
            error={history.error}
            message={t('settings.history.loadFailed')}
            onRetry={() => void history.refetch()}
          />
        ) : null}
        <ol ref={listRef} className={styles.history}>
          {entries.map((entry, index) => (
            <HistoryRow
              key={entry.version}
              entry={entry}
              index={index}
              detailsId={`${listId}-${index}`}
              open={expanded.has(entry.version)}
              isCurrent={entry.version === current}
              canRestore={canRevert}
              members={members}
              myHandle={myHandle}
              projectKey={key}
              onToggle={() => toggle(entry.version)}
              onRestore={() => askRestore(entry, index)}
            />
          ))}
        </ol>
        {history.hasNextPage ? (
          history.isFetchNextPageError ? (
            <ErrorState
              compact
              error={history.error}
              message={t('settings.history.olderFailed')}
              onRetry={() => void loadMore()}
            />
          ) : (
            <div className={styles.more}>
              <Button
                variant="secondary"
                size="md"
                disabled={history.isFetchingNextPage}
                onClick={() => void loadMore()}
              >
                {history.isFetchingNextPage
                  ? t('settings.history.loadingMore')
                  : history.data.pages.length === 1
                    ? t('settings.history.older', { count: total - entries.length })
                    : t('settings.history.more')}
              </Button>
            </div>
          )
        ) : null}
      </>
    );
  }

  return (
    <SettingsSection id="settings-history" title={t('settings.sections.history')}>
      <p className={shared.muted}>{t('settings.history.intro')}</p>
      {refreshed ? (
        <p className={clsx(shared.muted, styles.note)} role="status">
          {t('settings.history.refreshed')}
        </p>
      ) : null}
      {body}
      {!canRevert ? <p className={shared.muted}>{t('settings.history.ownerOnly')}</p> : null}
      <p className={styles.srOnly} role="status">
        {announcement}
      </p>
      <Dialog
        open={target !== null}
        onClose={closeDialog}
        title={t('settings.history.revertTitle')}
        description={t('settings.history.revertBody')}
        size="sm"
        returnFocusRef={returnFocus}
        error={revert.isError ? <ErrorBanner>{errorMessage(revert.error)}</ErrorBanner> : null}
        footer={
          <>
            <Button variant="secondary" size="md" autoFocus onClick={closeDialog}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" size="md" icon="undo" disabled={revert.isPending} onClick={restore}>
              {revert.isPending ? t('settings.history.reverting') : t('settings.history.revert')}
            </Button>
          </>
        }
      >
        {target ? (
          <div className={styles.target}>
            <span className={styles.summary}>{historySummary(target)}</span>
            <span className={shared.muted}>
              {historyAuthorOf(target, members, myHandle)} · {formatStamp(target.at)} ·{' '}
              {t('settings.history.versionShort', { version: target.version.slice(0, 7) })}
            </span>
          </div>
        ) : null}
      </Dialog>
    </SettingsSection>
  );
}

function HistoryRow({
  entry,
  index,
  detailsId,
  open,
  isCurrent,
  canRestore,
  members,
  myHandle,
  projectKey,
  onToggle,
  onRestore,
}: {
  entry: ConfigHistoryEntry;
  index: number;
  detailsId: string;
  open: boolean;
  isCurrent: boolean;
  canRestore: boolean;
  members: MemberIndex;
  myHandle: string | null;
  projectKey: string;
  onToggle: () => void;
  onRestore: () => void;
}) {
  const summary = historySummary(entry);
  const member = avatarMember(entry, members);
  const stamp = (
    <time dateTime={entry.at} title={entry.version.slice(0, 7)}>
      {formatStamp(entry.at)}
    </time>
  );
  return (
    <li className={styles.row} data-row={index}>
      <Avatar
        actor={entry.actor}
        via={entry.via}
        member={member}
        handle={entry.author}
        isMe={member !== undefined && member.handle === myHandle}
        size="md"
      />
      <div className={styles.text}>
        <span className={styles.summary}>{summary}</span>
        <span className={clsx(shared.muted, styles.byLine)}>
          {entry.actor ? (
            <ActorName
              actor={entry.actor}
              members={members}
              myHandle={myHandle}
              projectKey={projectKey}
              history
              after={
                <>
                  <span aria-hidden="true"> ·&nbsp;</span>
                  {stamp}
                </>
              }
            />
          ) : (
            <span>
              {historyAuthorOf(entry, members, myHandle)}
              <span aria-hidden="true"> ·&nbsp;</span>
              {stamp}
            </span>
          )}
          {isCurrent ? <Chip tone="ok">{t('settings.history.current')}</Chip> : null}
          {entry.approvedBy ? (
            <Chip tone="ok">
              {t('settings.history.approvedBy', { name: nameOf(entry.approvedBy, members, myHandle) })}
            </Chip>
          ) : null}
        </span>
        {entry.request ? (
          <span className={styles.request} title={entry.request}>
            {t('settings.history.request', { quote: entry.request })}
          </span>
        ) : null}
      </div>
      <div className={styles.actions}>
        <Button
          variant="ghost"
          size="sm"
          className={styles.detailsButton}
          data-details=""
          aria-expanded={open}
          aria-controls={open ? detailsId : undefined}
          aria-label={
            open
              ? t('settings.history.hideDetailsOf', { summary })
              : t('settings.history.detailsOf', { summary })
          }
          onClick={onToggle}
        >
          {open ? t('settings.history.hideDetails') : t('settings.history.details')}
        </Button>
        {canRestore && !isCurrent ? (
          <span className={styles.menu} data-more="">
            <MoreMenu label={t('settings.history.rowActions', { summary })}>
              {(close) => (
                <Button
                  variant="ghost"
                  size="md"
                  icon="undo"
                  onClick={() => {
                    close();
                    onRestore();
                  }}
                >
                  {t('settings.history.restoreAction')}
                </Button>
              )}
            </MoreMenu>
          </span>
        ) : null}
      </div>
      {open ? <HistoryDetails entry={entry} id={detailsId} /> : null}
    </li>
  );
}

/** Every change of a version on its own line, then the original text and the version itself. */
function HistoryDetails({ entry, id }: { entry: ConfigHistoryEntry; id: string }) {
  const lines = historyDetailLines(entry);
  return (
    <div id={id} className={styles.details}>
      {lines ? (
        <ul className={styles.changes}>
          {lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className={shared.muted}>{t('settings.history.noComparison')}</p>
      )}
      <dl className={styles.facts}>
        <dt>{t('settings.history.originalMessage')}</dt>
        <dd className={styles.raw}>{entry.message}</dd>
        <dt>{t('settings.history.version')}</dt>
        <dd>
          <code className={styles.raw}>{entry.version}</code>
        </dd>
        {entry.request ? (
          <>
            <dt>{t('settings.history.requestLabel')}</dt>
            <dd className={styles.raw}>{entry.request}</dd>
          </>
        ) : null}
        {entry.restores ? (
          <>
            <dt>
              {entry.restores.kind === 'undo'
                ? t('settings.history.undoneVersion')
                : t('settings.history.restoreTarget')}
            </dt>
            <dd>
              <code className={styles.raw}>{entry.restores.version}</code>
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
