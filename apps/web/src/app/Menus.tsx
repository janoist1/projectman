import clsx from 'clsx';
import { useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useLogout, useProjects } from '../api/queries';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { t } from '../i18n/t';
import { useDismiss } from '../lib/hooks';
import { useMeContext } from './contexts';
import styles from './Menus.module.css';

/** Project switcher: current project, other projects, new project. */
export function ProjectSwitcher({ currentKey, currentName, compact = false }: { currentKey: string; currentName: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const refs = useMemo(() => [triggerRef, panelRef], []);
  const panelId = useId();
  const projects = useProjects(open);
  useDismiss(open, () => setOpen(false), refs, triggerRef);

  return (
    <div className={styles.wrap}>
      <button
        ref={triggerRef}
        type="button"
        className={clsx(styles.projectTrigger, compact && styles.projectTriggerCompact)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('topbar.switchProject', { name: currentName })}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={clsx(styles.projectMark, compact && styles.projectMarkCompact)} aria-hidden="true">
          {currentName.slice(0, 1).toLowerCase()}
        </span>
        <span className={styles.projectName}>{currentName}</span>
        {compact ? null : <Icon name="chevronDown" size={16} strokeWidth={2} />}
      </button>
      {open ? (
        <div ref={panelRef} id={panelId} className={styles.panel}>
          <p className={styles.panelHeading}>{t('topbar.projects')}</p>
          <ul className={styles.list}>
            {(projects.data ?? [{ key: currentKey, name: currentName }]).map((project) => (
              <li key={project.key}>
                <Link
                  to={`/p/${project.key}`}
                  className={styles.item}
                  aria-current={project.key === currentKey ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                >
                  <span className={styles.projectMarkSmall} aria-hidden="true">
                    {project.name.slice(0, 1).toLowerCase()}
                  </span>
                  <span className={styles.itemText}>{project.name}</span>
                  <span className={styles.itemMeta}>{project.key}</span>
                  {project.key === currentKey ? <Icon name="check" size={15} strokeWidth={2.4} /> : null}
                </Link>
              </li>
            ))}
          </ul>
          <div className={styles.separator} />
          <Link to="/projects/new" className={styles.item} onClick={() => setOpen(false)}>
            <Icon name="plus" size={16} strokeWidth={2.2} />
            <span className={styles.itemText}>{t('topbar.newProject')}</span>
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/** Avatar button with the account: settings and logout. */
export function AccountMenu({ settingsPath, placement = 'right' }: { settingsPath: string | null; placement?: 'right' | 'below' }) {
  const me = useMeContext();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const refs = useMemo(() => [triggerRef, panelRef], []);
  const panelId = useId();
  const logout = useLogout();
  const navigate = useNavigate();
  useDismiss(open, () => setOpen(false), refs, triggerRef);

  return (
    <div className={styles.wrap}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.avatarButton}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('nav.account', { name: me.name })}
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar member={{ handle: 'me', displayName: me.name, kind: 'human', role: 'owner' }} isMe size="lg" />
      </button>
      {open ? (
        <div ref={panelRef} id={panelId} className={clsx(styles.panel, placement === 'right' ? styles.panelRight : styles.panelBelow)}>
          <div className={styles.account}>
            <span className={styles.accountName}>{me.name}</span>
            <span className={styles.accountEmail}>{me.email}</span>
          </div>
          <div className={styles.separator} />
          {settingsPath ? (
            <Link to={settingsPath} className={styles.item} onClick={() => setOpen(false)}>
              <Icon name="settings" size={16} />
              <span className={styles.itemText}>{t('nav.settings')}</span>
            </Link>
          ) : null}
          <button
            type="button"
            className={styles.item}
            onClick={() =>
              logout.mutate(undefined, {
                onSettled: () => navigate('/login', { replace: true }),
              })
            }
          >
            <Icon name="logout" size={16} />
            <span className={styles.itemText}>{t('topbar.logout')}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
