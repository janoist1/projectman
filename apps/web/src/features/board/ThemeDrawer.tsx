import { useState } from 'react';
import type { Ref } from 'react';
import clsx from 'clsx';
import { Link, useNavigate } from 'react-router';
import { isArchivedTheme, isOpenTask } from '@projectman/shared';
import type { BoardCard, ThemeCard, ThemeCardView } from '@projectman/shared';
import { useCloseTheme, useReopenTask, useUpdateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Chip, StatusDot } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toastContext';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import type { PipelineIndex } from '../../lib/pipeline';
import { isTaskClosed } from '../../lib/taskState';
import { CardSizeToggle, useCardLink } from './cardSize';
import { useDrawerBase } from './drawerBase';
import type { CardSize } from './cardSize';
import { TaskTitle } from './TaskEdit';
import { TaskPrioritySelect } from './TaskPriority';
import { cancelledIn, percentOf, progressOf, themeTree } from './themeModel';
import type { BoardEntry } from './useBoardModel';
import drawer from './drawer.module.css';
import head from './TaskHeader.module.css';
import styles from './ThemeDrawer.module.css';

/** The head of a theme's card (PM-192): the kind, the key and close, and the title, which is edited in place. */
export function ThemeHeader({
  task,
  headingRef,
  size,
  onToggleSize,
  onClose,
  rule = true,
}: {
  task: BoardCard;
  headingRef: Ref<HTMLHeadingElement>;
  size: CardSize;
  onToggleSize: (() => void) | undefined;
  onClose: () => void;
  /** The line under the head; the row of views under it has its own (PM-487). */
  rule?: boolean;
}) {
  return (
    <div className={clsx(head.head, !rule && head.bare)}>
      <div className={head.chips}>
        <Chip tone="neutral" size="md" icon="layers">
          {t('theme.badge')}
        </Chip>
        <span className={head.key}>{task.key}</span>
        <span className={head.spacer} />
        <CardSizeToggle size={size} onToggle={onToggleSize} />
        <Button variant="muted" iconOnly icon="close" onClick={onClose} aria-label={t('common.close')} />
      </div>
      <TaskTitle key={task.key} task={task} headingRef={headingRef} />
    </div>
  );
}

/**
 * How far the theme is and what a person can do with it: filter the board to it, close it, reopen it.
 * Closing leaves its cards as they are.
 */
export function ThemeSummary({ task, tasks }: { task: BoardCard; tasks: readonly BoardCard[] }) {
  const { key, can, setThemeFilter } = useProject();
  const navigate = useNavigate();
  const toast = useToast();
  const close = useCloseTheme(key);
  const reopen = useReopenTask(key);
  const open = isOpenTask(task);
  const progress = progressOf(task, tasks);
  const percent = percentOf(progress);
  const cancelled = cancelledIn(task, tasks);
  const change = open ? close : reopen;
  const archive = useUpdateTask(key);
  const archived = isArchivedTheme(task);
  // One error line serves the three actions: a new action drops the error the others left behind.
  const setArchived = (value: boolean) => {
    close.reset();
    reopen.reset();
    archive.mutate(
      { taskKey: task.key, body: { archived: value } },
      {
        onSuccess: () =>
          value
            ? toast.show(t('theme.archivedToast'), undefined, {
                action: { label: t('theme.undo'), run: () => setArchived(false) },
              })
            : toast.show(t('theme.unarchived')),
      },
    );
  };
  return (
    <section className={styles.summary} aria-label={t('theme.progressLabel')}>
      {archived ? (
        <div className={styles.archivedState}>
          <p className={styles.archivedHead}>
            <Icon name="archive" size={14} />
            {t('theme.archivedState', { when: formatAgo(task.archivedAt!) })}
          </p>
          <p>{t('theme.archivedNote')}</p>
        </div>
      ) : !open && task.closedAt ? (
        <p className={styles.closedState}>
          <Icon name="lock" size={14} />
          {t('theme.closedState', { when: formatAgo(task.closedAt) })}
        </p>
      ) : null}
      <div className={styles.progressHead}>
        <b className={styles.progressText}>{t('theme.progress', progress)}</b>
        <span className={styles.percent}>{t('theme.percent', { percent })}</span>
      </div>
      <div
        className={styles.bar}
        role="progressbar"
        aria-label={t('theme.progressLabel')}
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
      >
        <span className={styles.barDone} style={{ width: `${percent}%` }} />
      </div>
      {cancelled > 0 ? <p className={styles.note}>{t('theme.cancelledNote', { count: cancelled })}</p> : null}
      <TaskPrioritySelect task={task} help={t('priority.themeHelp')} />
      <div className={styles.buttons}>
        <Button
          variant="secondary"
          onClick={() => {
            setThemeFilter(task.key);
            navigate(`/p/${key}`);
          }}
        >
          {t('theme.filterBoard')}
        </Button>
        {can.createTasks ? (
          <Button
            variant={open ? 'secondary' : 'primary'}
            loading={change.isPending}
            onClick={() => {
              archive.reset();
              if (open) close.mutate(task.key, { onSuccess: () => toast.show(t('theme.closed')) });
              else reopen.mutate(task.key, { onSuccess: () => toast.show(t('theme.reopened')) });
            }}
          >
            {open ? t('theme.close') : t('theme.reopen')}
          </Button>
        ) : null}
        {can.createTasks ? (
          <Button variant="secondary" loading={archive.isPending} onClick={() => setArchived(!archived)}>
            {archived ? t('theme.unarchive') : t('theme.archive')}
          </Button>
        ) : null}
      </div>
      {change.isError || archive.isError ? (
        <p role="alert" className={drawer.error}>
          {errorMessage(change.isError ? change.error : archive.error)}
        </p>
      ) : null}
    </section>
  );
}

function CardRow({
  card,
  pipeline,
  byKey,
}: {
  card: ThemeCardView;
  pipeline: PipelineIndex;
  byKey: ReadonlyMap<string, BoardEntry>;
}) {
  const drawerBase = useDrawerBase();
  const cardLink = useCardLink();
  const closed = isTaskClosed(card);
  return (
    <>
      <StatusDot phase={byKey.get(card.key)?.state.phase} status={card.status} size={9} />
      <Link to={cardLink(drawerBase.card(card.key))} className={styles.cardLink}>
        <span className={styles.cardKey}>{card.key}</span> {card.title}
      </Link>
      <Chip>
        {closed
          ? t(`taskStatus.statuses.${card.status}`)
          : (pipeline.stageById.get(card.stageId)?.name ?? card.stageId)}
      </Chip>
    </>
  );
}

function CardTreeItem({
  card,
  pipeline,
  byKey,
}: {
  card: ThemeCard;
  pipeline: PipelineIndex;
  byKey: ReadonlyMap<string, BoardEntry>;
}) {
  const [expanded, setExpanded] = useState(true);
  const done = card.subtasks.filter((child) => child.status === 'done').length;
  const total = card.subtasks.filter((child) => child.status !== 'cancelled').length;
  return (
    <li className={styles.item}>
      <div className={styles.row}>
        {card.subtasks.length > 0 ? (
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={expanded}
            aria-label={t(expanded ? 'theme.collapse' : 'theme.expand', { key: card.key })}
            onClick={() => setExpanded((value) => !value)}
          >
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
          </button>
        ) : (
          <span className={styles.toggle} aria-hidden="true" />
        )}
        <CardRow card={card} pipeline={pipeline} byKey={byKey} />
        {card.subtasks.length > 0 ? (
          <span className={styles.kids}>{t('theme.subtasksProgress', { done, total })}</span>
        ) : null}
      </div>
      {card.subtasks.length > 0 && expanded ? (
        <ul className={styles.subtasks} aria-label={t('theme.subtasksOf', { key: card.key })}>
          {card.subtasks.map((child) => (
            <li key={child.key} className={styles.row}>
              <CardRow card={child} pipeline={pipeline} byKey={byKey} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The cards of a theme as a tree: collecting cards with their subtasks indented, the open ones first. */
export function ThemeCards({
  task,
  tasks,
  pipeline,
  byKey,
}: {
  task: BoardCard;
  tasks: readonly BoardCard[];
  pipeline: PipelineIndex;
  byKey: ReadonlyMap<string, BoardEntry>;
}) {
  const tree = themeTree(task, tasks);
  const count = tree.reduce((sum, card) => sum + 1 + card.subtasks.length, 0);
  return (
    <section className={drawer.section}>
      <div className={styles.cardsHead}>
        <h3 className={drawer.sectionTitle}>{t('theme.cards')}</h3>
        <span className={styles.cardsCount}>{t('theme.cardsCount', { count })}</span>
      </div>
      {tree.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{t('theme.empty')}</p>
          <p className={styles.note}>{t('theme.emptyHint')}</p>
        </div>
      ) : (
        <ul className={styles.tree}>
          {tree.map((card) => (
            <CardTreeItem key={card.key} card={card} pipeline={pipeline} byKey={byKey} />
          ))}
        </ul>
      )}
    </section>
  );
}
