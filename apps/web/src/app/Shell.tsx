import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { BoardView } from '@projectman/shared';
import { useConnectionStatus } from '../api/SocketProvider';
import { AvatarStack } from '../components/Avatar';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { joinNames, t } from '../i18n/t';
import { nameOf } from '../lib/members';
import type { MemberIndex } from '../lib/members';
import { AccountMenu, ProjectSwitcher } from './Menus';
import { PlanUsageMeter } from './PlanUsageMeter';
import { useProject } from './contexts';
import styles from './Shell.module.css';

const isMockMode = import.meta.env.VITE_MOCK === '1';

interface NavItem {
  to: string;
  icon: IconName;
  label: string;
  active: boolean;
  badge?: number;
}

function useNavItems(inboxCount: number): { main: NavItem[]; settings: NavItem } {
  const { key } = useProject();
  const { pathname } = useLocation();
  const base = `/p/${key}`;
  const under = (path: string) => pathname === path || pathname.startsWith(`${path}/`);
  const boardActive =
    pathname === base || pathname === `${base}/` || under(`${base}/tasks`) || under(`${base}/sessions`);
  return {
    main: [
      { to: base, icon: 'board', label: t('nav.board'), active: boardActive },
      { to: `${base}/team`, icon: 'team', label: t('nav.team'), active: under(`${base}/team`) },
      { to: `${base}/inbox`, icon: 'inbox', label: t('nav.inbox'), active: under(`${base}/inbox`), badge: inboxCount },
      { to: `${base}/messages`, icon: 'messages', label: t('nav.messages'), active: under(`${base}/messages`) },
    ],
    settings: { to: `${base}/settings`, icon: 'settings', label: t('nav.settings'), active: under(`${base}/settings`) },
  };
}

function BadgeText({ count }: { count: number }) {
  return <span className="visually-hidden">, {t('nav.inboxCount', { count })}</span>;
}

/** Left navigation rail (desktop and tablet). */
export function NavRail({ inboxCount }: { inboxCount: number }) {
  const { key } = useProject();
  const { main, settings } = useNavItems(inboxCount);
  return (
    <nav aria-label={t('nav.main')} className={styles.rail}>
      <Link to={`/p/${key}`} className={styles.logo} aria-label={t('app.name')}>
        <Icon name="logo" size={20} strokeWidth={2.4} />
      </Link>
      {isMockMode ? (
        <span className={styles.demo} title={t('app.demoModeHint')}>
          {t('app.demoMode')}
        </span>
      ) : null}
      {main.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className={clsx(styles.railItem, item.active && styles.railItemActive)}
          aria-current={item.active ? 'page' : undefined}
        >
          <Icon name={item.icon} size={20} strokeWidth={1.8} />
          <span className={styles.railLabel}>{item.label}</span>
          {item.badge ? (
            <>
              <span className={styles.railBadge} aria-hidden="true">
                {item.badge}
              </span>
              <BadgeText count={item.badge} />
            </>
          ) : null}
        </Link>
      ))}
      <span className={styles.spacer} />
      <Link
        to={settings.to}
        className={clsx(styles.railIcon, settings.active && styles.railIconActive)}
        aria-current={settings.active ? 'page' : undefined}
        aria-label={settings.label}
        title={settings.label}
      >
        <Icon name="settings" size={20} strokeWidth={1.8} />
      </Link>
      <AccountMenu settingsPath={settings.to} placement="right" />
    </nav>
  );
}

/** Bottom tab bar on phones. */
export function TabBar({ inboxCount }: { inboxCount: number }) {
  const { main } = useNavItems(inboxCount);
  return (
    <nav aria-label={t('nav.main')} className={styles.tabbar}>
      {main.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className={clsx(styles.tab, item.active && styles.tabActive)}
          aria-current={item.active ? 'page' : undefined}
        >
          <span className={styles.tabIcon}>
            <Icon name={item.icon} size={22} strokeWidth={item.active ? 2 : 1.8} />
            {item.badge ? (
              <span className={styles.tabBadge} aria-hidden="true">
                {item.badge}
              </span>
            ) : null}
          </span>
          <span className={styles.tabLabel}>{item.label}</span>
          {item.badge ? <BadgeText count={item.badge} /> : null}
        </Link>
      ))}
    </nav>
  );
}

function InboxPill({ count, compact = false }: { count: number; compact?: boolean }) {
  const { key } = useProject();
  if (count === 0 && compact) return null;
  return (
    <Link
      to={`/p/${key}/inbox`}
      className={clsx(styles.inboxPill, compact && styles.inboxPillCompact, count === 0 && styles.inboxPillQuiet)}
      aria-label={t('topbar.inboxPillLabel', { count })}
    >
      {compact ? null : <Icon name="bell" size={18} strokeWidth={2} />}
      <span>{t('topbar.inboxPill')}</span>
      {count > 0 ? <span className={styles.pillCount}>{count}</span> : null}
    </Link>
  );
}

function SearchBox() {
  const { key, search, setSearch } = useProject();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const onBoard = pathname === `/p/${key}` || pathname.startsWith(`/p/${key}/tasks`);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <form
      role="search"
      className={styles.search}
      onSubmit={(event) => {
        event.preventDefault();
        if (!onBoard) navigate(`/p/${key}`);
      }}
    >
      <Icon name="search" size={17} strokeWidth={2} />
      <label htmlFor="pm-search" className="visually-hidden">
        {t('topbar.search')}
      </label>
      <input
        ref={inputRef}
        id="pm-search"
        type="search"
        className={styles.searchInput}
        placeholder={t('topbar.searchPlaceholder')}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setSearch('');
        }}
      />
      {search ? (
        <button type="button" className={styles.searchClear} onClick={() => setSearch('')} aria-label={t('topbar.searchClear')}>
          <Icon name="close" size={14} strokeWidth={2.2} />
        </button>
      ) : (
        <kbd className={styles.kbd} aria-hidden="true">
          /
        </kbd>
      )}
    </form>
  );
}

function Presence({ board, members }: { board: BoardView | undefined; members: MemberIndex }) {
  const { myHandle } = useProject();
  const online = (board?.members ?? []).filter((member) => member.kind === 'human' && member.status === 'online');
  if (online.length === 0) return null;
  const names = joinNames(online.map((member) => nameOf(member.handle, members, myHandle)));
  return (
    <span className={styles.presence}>
      <AvatarStack
        size="md"
        label={t('topbar.presence', { names })}
        members={online.map((member) => ({ member, handle: member.handle, isMe: member.handle === myHandle }))}
      />
    </span>
  );
}

/** Desktop top bar: project, search, plan usage, who is here, inbox, new task. */
export function TopBar({
  board,
  members,
  inboxCount,
  pauseAbove,
}: {
  board: BoardView | undefined;
  members: MemberIndex;
  inboxCount: number;
  pauseAbove: number | undefined;
}) {
  const { key, openNewTask } = useProject();
  return (
    <header className={styles.topbar}>
      <ProjectSwitcher currentKey={key} currentName={board?.project.name ?? key} />
      <SearchBox />
      <span className={styles.spacer} />
      <span className={styles.hideNarrow}>
        <PlanUsageMeter usage={board?.planUsage} pauseAbove={pauseAbove} />
      </span>
      <span className={styles.hideNarrow}>
        <Presence board={board} members={members} />
      </span>
      <InboxPill count={inboxCount} />
      <Button variant="primary" icon="plus" onClick={openNewTask}>
        {t('topbar.newTask')}
      </Button>
    </header>
  );
}

/** Phone header: project chip, inbox pill, account. */
export function MobileHeader({ board, inboxCount }: { board: BoardView | undefined; inboxCount: number }) {
  const { key, openNewTask } = useProject();
  return (
    <header className={styles.mobileHeader}>
      <ProjectSwitcher currentKey={key} currentName={board?.project.name ?? key} compact />
      {isMockMode ? (
        <span className={styles.demoInline} title={t('app.demoModeHint')}>
          {t('app.demoMode')}
        </span>
      ) : null}
      <span className={styles.spacer} />
      <InboxPill count={inboxCount} compact />
      <Button variant="primary" size="md" iconOnly icon="plus" onClick={openNewTask} aria-label={t('topbar.newTask')} />
      <AccountMenu settingsPath={`/p/${key}/settings`} placement="below" />
    </header>
  );
}

/** Shown while the live connection is down. */
export function ConnectionBanner() {
  const status = useConnectionStatus();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (status !== 'connecting') {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), 2500);
    return () => clearTimeout(timer);
  }, [status]);
  const text = status === 'reconnecting' ? t('connection.reconnecting') : status === 'connecting' && slow ? t('connection.connecting') : null;
  if (!text) return null;
  return (
    <div className={styles.banner} role="status">
      <span className={styles.bannerSpinner} aria-hidden="true" />
      {text}
    </div>
  );
}
