import clsx from 'clsx';
import { Link } from 'react-router';
import { useProject } from '../../app/contexts';
import { t } from '../../i18n/t';
import styles from './TeamTabs.module.css';

export type TeamTab = 'members' | 'queues';

/**
 * The two views of the Team page: the roster and the work queues. They are links, so the browser's Back button
 * returns to the other tab; the work queues' own filters live in the URL after `view=queues`.
 */
export function TeamTabs({ active }: { active: TeamTab }) {
  const { key } = useProject();
  const tabs: Array<{ id: TeamTab; to: string; label: string }> = [
    { id: 'members', to: `/p/${key}/team`, label: t('workQueues.tabs.members') },
    { id: 'queues', to: `/p/${key}/team?view=queues`, label: t('workQueues.tabs.queues') },
  ];
  return (
    <nav className={styles.tabs} aria-label={t('workQueues.tabs.label')}>
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          to={tab.to}
          className={clsx(styles.tab, active === tab.id && styles.active)}
          aria-current={active === tab.id ? 'page' : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
