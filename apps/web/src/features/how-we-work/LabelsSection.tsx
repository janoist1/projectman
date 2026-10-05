import { Fragment } from 'react';
import type { ReactNode } from 'react';
import type { TeamMapLabel } from '@projectman/shared';
import { Icon } from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import { t } from '../../i18n/t';
import { EditLink } from './EditLink';
import { useMapView } from './MapContext';
import { labelGroupOf } from './model';
import type { LabelGroupId } from './model';
import { LabelButton } from './parts';
import styles from './HowWeWork.module.css';

const GROUPS: { id: LabelGroupId; icon: IconName | null }[] = [
  { id: 'results', icon: 'check' },
  { id: 'approvals', icon: 'user' },
  { id: 'blocking', icon: 'clock' },
  { id: 'other', icon: null },
];

/** The project's labels in boxes by what they do; results that exclude each other sit in one row. */
export function LabelsSection() {
  const { map } = useMapView();
  if (map.labels.length === 0) {
    return (
      <div className={styles.labelGroup}>
        <p>{t('howWeWork.label.none')}</p>
        <EditLink hash="settings-labels" inFoot={false}>
          {t('howWeWork.label.editAll')}
        </EditLink>
      </div>
    );
  }
  return (
    <div className={styles.labelGroups}>
      {GROUPS.map(({ id, icon }) => {
        const labels = map.labels.filter((entry) => labelGroupOf(entry) === id);
        if (labels.length === 0) return null;
        return (
          <div key={id} className={styles.labelGroup}>
            <h3>
              {icon ? <Icon name={icon} size={15} /> : null}
              {t(`howWeWork.label.groups.${id}`)}
            </h3>
            <p>{t(`howWeWork.label.groups.${id}Hint`)}</p>
            {id === 'results' ? <ExclusiveRows labels={labels} /> : <Chips labels={labels} />}
          </div>
        );
      })}
    </div>
  );
}

function Chips({ labels }: { labels: TeamMapLabel[] }) {
  return (
    <div className={styles.chips}>
      {labels.map((entry) => (
        <LabelButton key={entry.label.id} id={entry.label.id} />
      ))}
    </div>
  );
}

function ExclusiveRows({ labels }: { labels: TeamMapLabel[] }) {
  const rows = new Map<string, TeamMapLabel[]>();
  for (const entry of labels) {
    const group = entry.label.group ?? '';
    rows.set(group, [...(rows.get(group) ?? []), entry]);
  }
  return (
    <>
      {[...rows.entries()].map(([group, entries]) => (
        <div key={group} className={styles.setRow}>
          {entries.map((entry, index): ReactNode => (
            <Fragment key={entry.label.id}>
              {index > 0 ? <span className={styles.sep}>/</span> : null}
              <LabelButton id={entry.label.id} />
            </Fragment>
          ))}
        </div>
      ))}
    </>
  );
}
