import clsx from 'clsx';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { PROJECT_FOCUS_MAX_ITEMS, isOpenTask, isTheme } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Fold } from '../../components/Fold';
import { Icon } from '../../components/Icon';
import { Timeline } from '../../components/Timeline';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { useDrawerBase } from '../board/drawerBase';
import { useFocus } from './FocusContext';
import { useFocusChanges } from './useFocusChanges';
import styles from './FocusPanel.module.css';

/** The stage a card waits in until a developer picks it up (the "Indulhat" queue). */
const READY_STAGE = 'ready';

const NO_OPEN_INBOX: ReadonlySet<string> = new Set();

/** How many matches the search lists in a group. */
const MATCHES_PER_GROUP = 6;

interface ThemeStats {
  done: number;
  total: number;
  ready: number;
}

/** A save that failed: the message, and what to do to try it again. */
interface SaveFailure {
  message: string;
  retry: () => void;
}

/** The note after a removal: the item and its place, to put it back where it was. */
interface Removed {
  key: string;
  title: string;
  position: number;
}

/**
 * The project's focus as a sheet from the right (PM-438): the ordered list with its buttons to move and
 * take off, the search that adds a theme or a card, and the latest changes. A viewer who may not set the
 * focus gets the list to read only.
 */
export function FocusPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        <span className={styles.heading}>
          <Icon name="target" size={20} strokeWidth={2.2} />
          {t('focus.title')}
        </span>
      }
      description={t('focus.intro')}
      className={styles.sheet}
    >
      <PanelBody onClose={onClose} />
    </Dialog>
  );
}

function PanelBody({ onClose }: { onClose: () => void }) {
  const { key } = useProject();
  const { items, canEdit, full, tasksByKey, add, move, remove } = useFocus();
  const { members, pipeline } = useProjectIndexes(key);
  const { myHandle } = useProject();
  const base = useDrawerBase();
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [removed, setRemoved] = useState<Removed | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const refocus = useRef<{ key: string; dir: 'up' | 'down' | 'remove' } | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const changes = useFocusChanges(true);

  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), 700);
    return () => clearTimeout(timer);
  }, [highlight]);

  // After a move the row is at its new place; the button that was pressed gets the focus back.
  useEffect(() => {
    const target = refocus.current;
    if (!target) return;
    refocus.current = null;
    const row = list.current?.querySelector<HTMLElement>(`[data-key="${target.key}"]`);
    const buttons = row?.querySelectorAll<HTMLButtonElement>('button[data-move]');
    const wanted = row?.querySelector<HTMLButtonElement>(`button[data-move="${target.dir}"]:not(:disabled)`);
    (wanted ?? Array.from(buttons ?? []).find((button) => !button.disabled))?.focus();
  });

  const stats = useMemo(() => {
    const byTheme = new Map<string, ThemeStats>();
    for (const task of tasksByKey.values()) {
      if (isTheme(task) || task.parentKey || !task.themeKey || task.status === 'cancelled') continue;
      const entry = byTheme.get(task.themeKey) ?? { done: 0, total: 0, ready: 0 };
      entry.total += 1;
      if (task.status === 'done') entry.done += 1;
      else if (task.stageId === READY_STAGE) entry.ready += 1;
      byTheme.set(task.themeKey, entry);
    }
    return byTheme;
  }, [tasksByKey]);

  /** Runs a save; when the server refuses it the list has gone back, and the banner says so. */
  const run = (action: () => Promise<void>, onDone?: () => void) => {
    setFailure(null);
    action().then(onDone, (error: unknown) =>
      setFailure({ message: errorMessage(error), retry: () => run(action, onDone) }),
    );
  };

  const titleOf = (itemKey: string) => tasksByKey.get(itemKey)?.title ?? itemKey;

  const onAdd = (itemKey: string) => {
    setRemoved(null);
    setHighlight(itemKey);
    run(() => add(itemKey));
  };
  const onMove = (itemKey: string, position: number, dir: 'up' | 'down') => {
    setRemoved(null);
    setHighlight(itemKey);
    refocus.current = { key: itemKey, dir };
    setAnnouncement(`${titleOf(itemKey)}: ${t('focus.row.place', { position })}`);
    run(() => move(itemKey, position));
  };
  const onRemove = (itemKey: string, position: number) => {
    const title = titleOf(itemKey);
    setRemoved(null);
    run(
      () => remove(itemKey),
      () => setRemoved({ key: itemKey, title, position }),
    );
  };
  const onUndo = (note: Removed) => {
    setRemoved(null);
    setHighlight(note.key);
    run(() => add(note.key, note.position));
  };

  return (
    <div className={styles.body}>
      {!canEdit ? (
        <p className={styles.viewer}>
          <Icon name="lock" size={15} strokeWidth={2.2} />
          {t('focus.viewerNote')}
        </p>
      ) : null}
      {failure ? (
        <ErrorBanner className={styles.banner}>
          <span>
            {t('focus.saveFailed')}
            {/* The general "something went wrong" adds nothing after our own sentence; a specific reason does. */}
            {failure.message === t('errors.generic') ? '' : ` ${failure.message}`}
          </span>
          <Button variant="secondary" size="sm" onClick={failure.retry}>
            {t('focus.retry')}
          </Button>
        </ErrorBanner>
      ) : null}
      {canEdit ? <FocusSearch tasks={tasksByKey} pipeline={pipeline} full={full} onPick={onAdd} /> : null}
      {removed ? (
        <p className={styles.removed} role="status">
          <span>{t('focus.removed', { title: removed.title })}</span>
          {canEdit ? (
            <Button variant="ghost" size="sm" onClick={() => onUndo(removed)}>
              {t('focus.undo')}
            </Button>
          ) : null}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className={styles.empty}>{t('focus.empty')}</p>
      ) : (
        <ol ref={list} className={styles.list} aria-label={t('focus.listLabel')}>
          {items.map((item, index) => {
            const task = tasksByKey.get(item.key);
            const closed = task ? !isOpenTask(task) : false;
            const title = task?.title ?? item.key;
            const theme = task ? isTheme(task) : false;
            const themeStats = theme ? stats.get(item.key) : undefined;
            const position = index + 1;
            const stageName = task ? pipeline?.stageById.get(task.stageId)?.name : undefined;
            return (
              <li
                key={item.key}
                data-key={item.key}
                className={clsx(
                  styles.row,
                  closed && styles.closed,
                  highlight === item.key && styles.highlight,
                )}
              >
                <span className={styles.number} aria-hidden="true">
                  {position}
                </span>
                <div className={styles.main}>
                  <Link className={styles.title} to={base.card(item.key)} onClick={onClose}>
                    <span className="visually-hidden">{t('focus.position', { position })}</span>
                    {title}
                  </Link>
                  <span className={styles.meta}>
                    {task ? (
                      <span className={styles.kind}>
                        {theme ? t('focus.kindTheme') : t('focus.kindCard')}
                      </span>
                    ) : null}
                    {closed ? (
                      <span>{t('focus.itemClosed')}</span>
                    ) : theme && themeStats ? (
                      <>
                        <span>
                          {t('focus.themeProgress', { done: themeStats.done, total: themeStats.total })}
                        </span>
                        {themeStats.ready > 0 ? (
                          <span className={styles.ready}>
                            {t('focus.themeReady', { count: themeStats.ready })}
                          </span>
                        ) : null}
                      </>
                    ) : theme && task ? (
                      <span>{t('focus.noThemeCards')}</span>
                    ) : task ? (
                      <>
                        <span className={styles.key}>{item.key}</span>
                        {readyCard(task) ? (
                          <span className={styles.ready}>{t('focus.cardReady')}</span>
                        ) : stageName ? (
                          <span>{stageName}</span>
                        ) : null}
                      </>
                    ) : null}
                  </span>
                </div>
                {canEdit ? (
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      data-move="up"
                      disabled={index === 0}
                      aria-label={t('focus.moveUp', { title })}
                      title={t('focus.moveUp', { title })}
                      onClick={() => onMove(item.key, position - 1, 'up')}
                    >
                      <Icon name="arrowUp" size={16} strokeWidth={2.2} />
                    </button>
                    <button
                      type="button"
                      className={styles.iconButton}
                      data-move="down"
                      disabled={closed || index === items.length - 1}
                      aria-label={t('focus.moveDown', { title })}
                      title={t('focus.moveDown', { title })}
                      onClick={() => onMove(item.key, position + 1, 'down')}
                    >
                      <Icon name="arrowDown" size={16} strokeWidth={2.2} />
                    </button>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label={t('focus.remove', { title })}
                      title={t('focus.remove', { title })}
                      onClick={() => onRemove(item.key, position)}
                    >
                      <Icon name="close" size={16} strokeWidth={2.2} />
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
      <p className={styles.urgent}>
        <Icon name="flag" size={15} strokeWidth={2.2} />
        {t('focus.urgentNote')}
      </p>
      <Fold summary={t('focus.changes')}>
        {changes.isError ? (
          <p className={styles.empty}>{t('focus.changesFailed')}</p>
        ) : (
          <Timeline
            events={changes.data?.events ?? []}
            emptyText={t('focus.changesEmpty')}
            ctx={{ pipeline, members, myHandle, openInboxIds: NO_OPEN_INBOX }}
          />
        )}
      </Fold>
    </div>
  );
}

function readyCard(task: Task): boolean {
  return isOpenTask(task) && task.stageId === READY_STAGE;
}

/** The search that adds: open themes and cards by title or key; one that is in the list is shown, not offered. */
function FocusSearch({
  tasks,
  pipeline,
  full,
  onPick,
}: {
  tasks: ReadonlyMap<string, Task>;
  pipeline: ReturnType<typeof useProjectIndexes>['pipeline'];
  full: boolean;
  onPick: (key: string) => void;
}) {
  const { items } = useFocus();
  const id = useId();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(0);

  const placeOf = useMemo(() => new Map(items.map((item, index) => [item.key, index + 1])), [items]);
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const found = [...tasks.values()].filter(
      (task) =>
        isOpenTask(task) &&
        !task.parentKey &&
        (needle === '' ||
          task.title.toLowerCase().includes(needle) ||
          task.key.toLowerCase().includes(needle)),
    );
    const themes = found.filter(isTheme).slice(0, MATCHES_PER_GROUP);
    const cards = found.filter((task) => !isTheme(task)).slice(0, MATCHES_PER_GROUP);
    return { themes, cards, all: [...themes, ...cards] };
  }, [tasks, query]);

  if (full) {
    return (
      <div className={styles.search}>
        <input
          className={styles.input}
          type="text"
          disabled
          aria-label={t('focus.addLabel')}
          placeholder={t('focus.searchPlaceholder')}
        />
        <p className={styles.muted}>{t('errors.codes.focus_full')}</p>
      </div>
    );
  }

  const pick = (task: Task) => {
    if (placeOf.has(task.key)) return;
    onPick(task.key);
    setQuery('');
    setExpanded(false);
  };
  const optionId = (task: Task) => `${id}-${task.key}`;
  const current = options.all[Math.min(active, options.all.length - 1)];

  const group = (label: string, group: Task[]) =>
    group.length === 0 ? null : (
      <li role="presentation" className={styles.group}>
        <span className={styles.groupLabel} id={`${id}-${label}`}>
          {label}
        </span>
        <ul role="group" aria-labelledby={`${id}-${label}`} className={styles.options}>
          {group.map((task) => {
            const place = placeOf.get(task.key);
            const hint =
              place !== undefined
                ? t('focus.alreadyIn', { position: place })
                : isTheme(task)
                  ? ''
                  : (pipeline?.stageById.get(task.stageId)?.name ?? '');
            return (
              <li
                key={task.key}
                id={optionId(task)}
                role="option"
                aria-selected={current?.key === task.key}
                aria-disabled={place !== undefined || undefined}
                className={clsx(
                  styles.option,
                  current?.key === task.key && styles.activeOption,
                  place !== undefined && styles.optionIn,
                )}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(task)}
              >
                {isTheme(task) ? null : <span className={styles.key}>{task.key}</span>}
                <span className={styles.optionTitle}>{task.title}</span>
                {hint ? <span className={styles.hint}>{hint}</span> : null}
              </li>
            );
          })}
        </ul>
      </li>
    );

  return (
    <div className={styles.search}>
      <input
        className={styles.input}
        type="text"
        role="combobox"
        aria-label={t('focus.addLabel')}
        aria-expanded={expanded}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={expanded && current ? optionId(current) : undefined}
        placeholder={t('focus.searchPlaceholder')}
        value={query}
        maxLength={PROJECT_FOCUS_MAX_ITEMS * 10}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setExpanded(true);
        }}
        onFocus={() => setExpanded(true)}
        onBlur={() => setExpanded(false)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setExpanded(true);
            const count = options.all.length;
            if (count > 0) setActive((at) => (at + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
          } else if (event.key === 'Enter' && expanded && current) {
            event.preventDefault();
            pick(current);
          } else if (event.key === 'Escape' && expanded) {
            // The first Escape closes the list; the sheet stays.
            event.preventDefault();
            event.stopPropagation();
            setExpanded(false);
          }
        }}
      />
      {expanded ? (
        <ul id={`${id}-list`} role="listbox" aria-label={t('focus.addLabel')} className={styles.results}>
          {options.all.length === 0 ? (
            <li role="presentation" className={styles.noMatches}>
              {t('focus.noMatches')}
            </li>
          ) : (
            <>
              {group(t('focus.groupThemes'), options.themes)}
              {group(t('focus.groupCards'), options.cards)}
            </>
          )}
        </ul>
      ) : null}
    </div>
  );
}
