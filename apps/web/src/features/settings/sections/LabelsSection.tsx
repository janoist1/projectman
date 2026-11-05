import { useEffect, useId, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Link } from 'react-router';
import type { LabelView, ProjectConfig } from '@projectman/shared';
import { useBoard } from '../../../api/queries';
import { useProject } from '../../../app/contexts';
import { Button } from '../../../components/Button';
import { LabelChip } from '../../../components/LabelChip';
import { t } from '../../../i18n/t';
import { DetailPanel, MissingSettingsElement, SettingsDetailLayout } from '../DetailPanel';
import { LeaveGuardProvider } from '../edit/LeaveGuard';
import { LabelDetail } from '../labels/LabelDetail';
import { labelUsage } from '../labels/labelDraft';
import { LabelPanel } from '../labels/LabelPanel';
import { usageStages, whoText } from '../labels/labelText';
import { useSettingsSelection } from '../selection';
import shared from '../settings.module.css';
import styles from './LabelsSection.module.css';
import { SettingsSection } from './SettingsSection';

/** The tag of a card that has no label definition, and on how many cards it stands. */
interface UndefinedTag {
  tag: string;
  count: number;
}

const FLASH_MS = 1400;

/** The label vocabulary as a list; the selected label opens in a panel beside it (an editor for an admin). */
export function LabelsSection({ config }: { config: ProjectConfig }) {
  return (
    <LeaveGuardProvider>
      <LabelsBody config={config} />
    </LeaveGuardProvider>
  );
}

function LabelsBody({ config }: { config: ProjectConfig }) {
  const { key, can } = useProject();
  const board = useBoard(key);
  const selection = useSettingsSelection();
  const [query, setQuery] = useState('');
  /** The label that was just saved; `count` makes the same label flash again. */
  const [flash, setFlash] = useState<{ id: string; count: number } | null>(null);
  /** Where the focus goes once a deleted label's panel is closed: a label id, or null for "+ Új címke". */
  const refocus = useRef<{ id: string | null } | null>(null);
  const rowOrder = useRef<string[]>([]);
  /** The label that was deleted from the panel, until its undo brings it back. */
  const removedId = useRef<string | null>(null);
  /** The label that was just created from the panel, and whether the list has shown it yet. */
  const createdId = useRef<{ id: string; seen: boolean } | null>(null);
  const searchId = useId();
  const show = selection.show;
  const selectedId = show?.type === 'label' ? show.id : null;
  const selectedTag = show?.type === 'new-label' ? (show.tag ?? null) : null;

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);
  useEffect(() => {
    const target = refocus.current;
    if (!target || show) return;
    refocus.current = null;
    const row =
      target.id === null ? null : document.querySelector<HTMLElement>(`[data-label-row="${target.id}"]`);
    (row ?? document.querySelector<HTMLElement>('[data-settings-add-label]'))?.focus();
  }, [show, config]);

  const needle = query.trim().toLowerCase();
  const labels = config.pipeline.labels;
  const shown = useMemo(
    () =>
      labels.filter(
        (label) =>
          !needle ||
          label.name.toLowerCase().includes(needle) ||
          label.id.toLowerCase().includes(needle) ||
          (label.meaning ?? '').toLowerCase().includes(needle),
      ),
    [labels, needle],
  );
  const views = useMemo<LabelView[]>(() => labels.map((label) => ({ ...label, holders: [] })), [labels]);
  const undefinedTags = useMemo<UndefinedTag[]>(() => {
    const counts = new Map<string, number>();
    for (const task of board.data?.tasks ?? [])
      for (const tag of task.labels) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return [...counts]
      .filter(([tag]) => !labels.some((label) => label.id === tag))
      .map(([tag, count]) => ({ tag, count }))
      .filter(({ tag }) => !needle || tag.toLowerCase().includes(needle));
  }, [board.data?.tasks, labels, needle]);

  // The order of the rows before the open label went: the config of a deleted one is already new when the panel reports it.
  if (!selectedId || labels.some((label) => label.id === selectedId))
    rowOrder.current = shown.map((label) => label.id);
  /** The row after the deleted one, else the one before it, else the add button. */
  const nextFocus = (id: string): string | null => {
    const order = rowOrder.current;
    const index = order.indexOf(id);
    return order[index + 1] ?? order[index - 1] ?? null;
  };
  // A label that was just deleted and then restored by the undo takes the focus back; a label that was just created
  // and then undone leaves its panel, which would only say that the label is gone.
  useEffect(() => {
    const restored = removedId.current;
    if (restored && labels.some((label) => label.id === restored)) {
      removedId.current = null;
      document.querySelector<HTMLElement>(`[data-label-row="${restored}"]`)?.focus();
      setFlash((previous) => ({ id: restored, count: (previous?.count ?? 0) + 1 }));
    }
    const created = createdId.current;
    if (!created) return;
    if (labels.some((label) => label.id === created.id)) createdId.current = { id: created.id, seen: true };
    else if (created.seen) {
      createdId.current = null;
      if (selectedId === created.id) {
        refocus.current = { id: null };
        selection.close();
      }
    }
  }, [labels]);
  const empty = (
    <>
      <h2 className={styles.emptyTitle}>{t('settings.labels.edit.emptyTitle')}</h2>
      <p className={shared.muted}>
        {t(can.manageTeam ? 'settings.labels.edit.emptyBodyAdmin' : 'settings.labels.edit.emptyBody')}
      </p>
    </>
  );
  const back =
    selection.from === 'how-we-work' && selectedId ? (
      <Link className={styles.back} to={`/p/${key}/how-we-work?show=label:${selectedId}`}>
        {t('settings.pipeline.back')}
      </Link>
    ) : undefined;

  const host = (() => {
    const target =
      show?.type === 'new-label'
        ? show
        : show?.type === 'label'
          ? { type: 'label' as const, id: show.id }
          : null;
    if (can.manageTeam && target)
      return (
        <LabelPanel
          key={target.type === 'label' ? `label:${target.id}` : `new-label:${target.tag ?? ''}`}
          config={config}
          show={target}
          empty={empty}
          back={back}
          onClose={selection.close}
          onSaved={(id) => setFlash((previous) => ({ id, count: (previous?.count ?? 0) + 1 }))}
          onCreated={(id) => {
            // The saved config already holds the label, so the list has "seen" it: only its later removal closes the panel.
            createdId.current = { id, seen: true };
            selection.replace({ type: 'label', id });
          }}
          onRemoved={(id) => {
            removedId.current = id;
            refocus.current = { id: nextFocus(id) };
            selection.close();
          }}
        />
      );
    const label = show?.type === 'label' ? labels.find((candidate) => candidate.id === show.id) : undefined;
    if (show && !label)
      return (
        <DetailPanel
          open
          itemKey="gone"
          title={t('howWeWork.gone.title')}
          empty={empty}
          onClose={selection.close}
        >
          <MissingSettingsElement onClose={selection.close} />
        </DetailPanel>
      );
    if (label)
      return (
        <DetailPanel
          open
          itemKey={`label:${label.id}`}
          kicker={t('settings.labels.edit.kicker')}
          title={label.name}
          back={back}
          empty={empty}
          onClose={selection.close}
        >
          <LabelDetail config={config} label={label} />
        </DetailPanel>
      );
    return <DetailPanel open={false} itemKey="none" title="" empty={empty} onClose={selection.close} />;
  })();

  return (
    <SettingsSection
      id="settings-labels"
      title={t('settings.sections.labels')}
      meta={<span className={shared.muted}>{t('settings.labels.count', { count: labels.length })}</span>}
    >
      <p className={shared.muted}>{t('settings.labels.intro')}</p>
      <div className={styles.head}>
        <div className={styles.searchField}>
          <label htmlFor={searchId} className={styles.searchLabel}>
            {t('settings.labels.edit.searchLabel')}
          </label>
          <input
            id={searchId}
            type="search"
            className={styles.search}
            value={query}
            placeholder={t('settings.labels.edit.search')}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className={styles.found} role="status">
            {needle ? t('settings.labels.edit.found', { count: shown.length + undefinedTags.length }) : ''}
          </span>
        </div>
        {can.manageTeam ? (
          <Button
            variant="secondary"
            data-settings-add-label=""
            onClick={() => selection.open({ type: 'new-label' })}
          >
            {t('settings.labels.add')}
          </Button>
        ) : null}
      </div>
      <SettingsDetailLayout>
        <div>
          {labels.length === 0 && !needle ? (
            <p className={styles.empty}>{t('settings.labels.edit.noLabels')}</p>
          ) : shown.length === 0 && undefinedTags.length === 0 ? (
            <p className={styles.empty}>
              {t('settings.labels.edit.noMatch', { q: query.trim() })}{' '}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setQuery('');
                  document.getElementById(searchId)?.focus();
                }}
              >
                {t('settings.labels.edit.clearSearch')}
              </Button>
            </p>
          ) : (
            <ul className={styles.list}>
              {shown.map((label) => {
                const stages = usageStages(labelUsage(config, label.id));
                const meaning = label.meaning?.split('\n')[0];
                return (
                  <li key={label.id}>
                    <button
                      type="button"
                      className={clsx(styles.row, flash?.id === label.id && styles.flash)}
                      data-label-row={label.id}
                      aria-current={selectedId === label.id ? 'true' : undefined}
                      onClick={() => selection.open({ type: 'label', id: label.id })}
                    >
                      <LabelChip id={label.id} labels={views} />
                      {meaning ? <span className={styles.meaning}>{meaning}</span> : null}
                      <span className={styles.line}>
                        {t('settings.labels.edit.rowWho', { who: whoText(label, config) })}
                      </span>
                      {stages.length > 0 ? (
                        <span className={styles.line}>
                          {t('settings.labels.edit.rowGate', {
                            stages: stages.join(t('common.listSeparator')),
                          })}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {board.isError ? (
            <p className={clsx(styles.empty, styles.untitled)} role="status">
              {t('settings.labels.edit.tagsFailed')}{' '}
              <Button variant="secondary" size="sm" onClick={() => void board.refetch()}>
                {t('app.retry')}
              </Button>
            </p>
          ) : board.isPending ? (
            <p className={clsx(styles.empty, styles.untitled)} role="status">
              {t('settings.labels.edit.tagsLoading')}
            </p>
          ) : undefinedTags.length > 0 ? (
            <div className={styles.untitled}>
              <h3>{t('settings.labels.undefinedTitle')}</h3>
              <ul className={styles.list}>
                {undefinedTags.map(({ tag, count }) => (
                  <li key={tag}>
                    {can.manageTeam ? (
                      <button
                        type="button"
                        className={styles.row}
                        data-tag-row={tag}
                        aria-current={selectedTag === tag ? 'true' : undefined}
                        onClick={() => selection.open({ type: 'new-label', tag })}
                      >
                        <LabelChip id={tag} labels={[]} />
                        <span className={styles.line}>{t('settings.labels.onTasks', { count })}</span>
                        <span className={styles.define}>{t('settings.labels.define')}</span>
                      </button>
                    ) : (
                      <div className={styles.row}>
                        <LabelChip id={tag} labels={[]} />
                        <span className={styles.line}>{t('settings.labels.onTasks', { count })}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        {host}
      </SettingsDetailLayout>
    </SettingsSection>
  );
}
