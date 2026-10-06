import { useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { SelectField } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { SegmentedControl } from '../../components/SegmentedControl';
import { t } from '../../i18n/t';
import type { BoardFilter } from '../../lib/taskState';
import { FilterSelect } from './FilterSelect';
import type { useBoardFilters } from './useBoardFilters';
import styles from './BoardFilterControls.module.css';

type FilterView = ReturnType<typeof useBoardFilters>;

function PhaseFilter({ view, size }: { view: FilterView; size: 'sm' | 'md' }) {
  return (
    <SegmentedControl<BoardFilter>
      label={t('board.filtersLabel')}
      value={view.filters.phase}
      onChange={view.setPhase}
      size={size}
      className={styles.phase}
      options={[
        { value: 'all', label: t('board.filters.all'), count: view.counts.all },
        { value: 'needsYou', label: t('board.filters.needsYou'), count: view.counts.needsYou },
        { value: 'waiting', label: t('board.filters.waiting'), count: view.counts.waiting },
      ]}
    />
  );
}

/** Desktop: the state, the member and the label side by side, and the way to take them all off. */
export function DesktopFilters({ view }: { view: FilterView }) {
  return (
    <div className={styles.bar}>
      <PhaseFilter view={view} size="md" />
      <FilterSelect
        label={t('board.filterMember')}
        anyLabel={t('board.filterAny')}
        value={view.filters.assignee}
        options={view.assignees}
        onChange={view.setAssignee}
      />
      <FilterSelect
        label={t('board.filterLabel')}
        anyLabel={t('board.filterAny')}
        value={view.filters.label}
        options={view.labelChoices}
        onChange={view.setLabel}
      />
      {view.showPriority ? (
        <FilterSelect
          className={styles.priority}
          label={t('board.filterPriority')}
          anyLabel={t('board.filterAny')}
          value={view.filters.priority}
          options={view.priorityChoices}
          onChange={view.setPriority}
        />
      ) : null}
      {view.clearable > 0 ? (
        <Button variant="ghost" size="sm" onClick={view.clear}>
          {t('board.clearFilters')}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Phone: the state stays in the row; the member and the label are in a sheet behind a button, which
 * says how many of them are set.
 */
export function PhoneFilters({ view }: { view: FilterView }) {
  const [open, setOpen] = useState(false);
  const set = view.chips.length;
  return (
    <>
      <div className={styles.phoneBar}>
        <PhaseFilter view={view} size="sm" />
        <button
          type="button"
          className={styles.sheetButton}
          data-active={set > 0 ? 'true' : undefined}
          aria-label={set > 0 ? t('board.filterButtonActive', { count: set }) : t('board.filterButton')}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <Icon name="filter" size={18} strokeWidth={2.2} />
          {set > 0 ? (
            <span className={styles.badge} aria-hidden="true">
              {set}
            </span>
          ) : null}
        </button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('board.filterSheetTitle')}
        size="sm"
        footer={
          <>
            {view.clearable > 0 ? (
              <Button variant="ghost" onClick={view.clear}>
                {t('board.clearFilters')}
              </Button>
            ) : null}
            <Button variant="primary" onClick={() => setOpen(false)}>
              {t('board.filterShow', { count: view.visible.length })}
            </Button>
          </>
        }
      >
        <div className={styles.sheet}>
          <SelectField
            label={t('board.filterMember')}
            value={view.filters.assignee}
            onChange={(event) => view.setAssignee(event.target.value)}
          >
            <option value="">{t('board.filterAny')}</option>
            {view.assignees.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t('board.filterLabel')}
            value={view.filters.label}
            onChange={(event) => view.setLabel(event.target.value)}
          >
            <option value="">{t('board.filterAny')}</option>
            {view.labelChoices.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>
          {view.showPriority ? (
            <SelectField
              label={t('board.filterPriority')}
              value={view.filters.priority}
              onChange={(event) => view.setPriority(event.target.value)}
            >
              <option value="">{t('board.filterAny')}</option>
              {view.priorityChoices.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SelectField>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}

/** What the phone list is narrowed to by member and label, each to be taken off by itself. */
export function FilterChips({ view }: { view: FilterView }) {
  if (view.chips.length === 0) return null;
  return (
    <ul className={styles.chips}>
      {view.chips.map((chip) => (
        <li key={chip.id}>
          <button
            type="button"
            className={styles.chip}
            aria-label={t('board.filterChipRemove', { value: chip.value })}
            onClick={() =>
              chip.id === 'assignee'
                ? view.setAssignee('')
                : chip.id === 'priority'
                  ? view.setPriority('')
                  : view.setLabel('')
            }
          >
            <span className={styles.chipValue}>{chip.value}</span>
            <Icon name="close" size={14} strokeWidth={2.4} />
          </button>
        </li>
      ))}
    </ul>
  );
}
