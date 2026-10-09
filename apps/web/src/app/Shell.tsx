import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { DEFAULT_AGENT_PROVIDER, hasPlanUsage } from '@projectman/shared';
import type { BoardView } from '@projectman/shared';
import { useBoard, useTeamThreads } from '../api/queries';
import { useConnectionStatus } from '../api/socketHooks';
import { AvatarStack } from '../components/Avatar';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { openPauses } from '../features/pause/pauseView';
import { PmButton } from '../features/pm/PmButton';
import { joinNames, t } from '../i18n/t';
import { nameOf } from '../lib/members';
import { useMediaQuery } from '../lib/hooks';
import type { MemberIndex } from '../lib/members';
import { AccountMenu, ProjectSwitcher } from './Menus';
import { CombinedPlanUsageMeter, PlanUsageBadge, PlanUsageMeter } from './PlanUsageMeter';
import { useProject } from './contexts';
import styles from './Shell.module.css';
import { EngineIndicator } from '../features/engines/EngineIndicator';
import { MachineIndicator } from '../features/machine/MachineIndicator';

/*
 * The desktop top bar sheds width in steps, so nothing overlaps (the search field gives way first):
 *   >= 1600   the Szünet button shows, plan usages are compact (short item per provider, dropdown details)
 *   1500-1599 the Szünet button is hidden (the account menu has it; CSS in Shell.module.css), plan usages per provider
 *   1181-1499 plan usages collapse into a single combined button ("AI-keret {percent} ˅") with a shared dropdown
 *             (COMBINED_PLAN_USAGE_QUERY); the machine meter's button turns into a badge below 1280 (PM-322)
 *   <= 1180   the plan usage and the presence are hidden (CSS)
 *   >= 1500   the Projektmenedzser button (PM-429) shows the avatar and the display name (cut at 18 characters);
 *   901-1499  avatar and "PM"; <= 900 the avatar only (CSS in PmButton.module.css)
 *   <= 900    "Új feladat" is an icon only: COMPACT_NEW_TASK_QUERY
 *   < 768     the phone header replaces the bar (a plan usage badge, an icon-only new task)
 */
const COMPACT_NEW_TASK_QUERY = '(max-width: 900px)';
const COMBINED_PLAN_USAGE_QUERY = '(max-width: 1499px)';

interface NavItem {
  to: string;
  icon: IconName;
  label: string;
  active: boolean;
  badge?: number;
}

function useNavItems(inboxCount: number): {
  main: NavItem[];
  /** The "how we work" page: on the rail and in the phone's account menu, not in the tab bar; a client has none. */
  howWeWork: NavItem | null;
  settings: NavItem;
} {
  const { key, can } = useProject();
  // The server counts the viewer's unread messages across their conversations (PM-78).
  const unread = useTeamThreads(key).data?.unreadCount ?? 0;
  const { pathname } = useLocation();
  const base = `/p/${key}`;
  const under = (path: string) => pathname === path || pathname.startsWith(`${path}/`);
  const boardActive =
    pathname === base || pathname === `${base}/` || under(`${base}/tasks`) || under(`${base}/sessions`);
  return {
    main: [
      { to: base, icon: 'board', label: t('nav.board'), active: boardActive },
      { to: `${base}/map`, icon: 'nodes', label: t('nav.map'), active: under(`${base}/map`) },
      { to: `${base}/team`, icon: 'team', label: t('nav.team'), active: under(`${base}/team`) },
      {
        to: `${base}/inbox`,
        icon: 'inbox',
        label: t('nav.inbox'),
        active: under(`${base}/inbox`),
        badge: inboxCount,
      },
      {
        to: `${base}/messages`,
        icon: 'messages',
        label: t('nav.messages'),
        active: under(`${base}/messages`),
        badge: unread,
      },
    ],
    howWeWork: can.readConfig
      ? {
          to: `${base}/how-we-work`,
          icon: 'map',
          label: t('nav.howWeWork'),
          active: under(`${base}/how-we-work`),
        }
      : null,
    settings: {
      to: `${base}/settings`,
      icon: 'settings',
      label: t('nav.settings'),
      active: under(`${base}/settings`),
    },
  };
}

function BadgeText({ count }: { count: number }) {
  return <span className="visually-hidden">, {t('nav.inboxCount', { count })}</span>;
}

/** Left navigation rail (desktop and tablet). */
export function NavRail({ inboxCount }: { inboxCount: number }) {
  const { key, openPause, can } = useProject();
  const { main, howWeWork, settings } = useNavItems(inboxCount);
  const pause = useBoard(key).data?.pause;
  const canPause = can.pauseTeam && pause !== undefined && openPauses(pause).length === 0;
  return (
    <nav aria-label={t('nav.main')} className={styles.rail}>
      <Link to={`/p/${key}`} className={styles.logo} aria-label={t('app.name')}>
        <Icon name="logo" size={20} strokeWidth={2.4} />
      </Link>
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
      {howWeWork ? (
        <Link
          to={howWeWork.to}
          className={clsx(styles.railItem, styles.railItemTall, howWeWork.active && styles.railItemActive)}
          aria-current={howWeWork.active ? 'page' : undefined}
        >
          <Icon name={howWeWork.icon} size={20} strokeWidth={1.8} />
          <span className={clsx(styles.railLabel, styles.railLabelWrap)}>{howWeWork.label}</span>
        </Link>
      ) : null}
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
      <AccountMenu settingsPath={settings.to} placement="right" onPause={canPause ? openPause : undefined} />
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

function InboxPill({ count }: { count: number }) {
  const { key } = useProject();
  return (
    <Link
      to={`/p/${key}/inbox`}
      className={clsx(styles.inboxPill, count === 0 && styles.inboxPillQuiet)}
      aria-label={t('topbar.inboxPillLabel', { count })}
    >
      <Icon name="bell" size={18} strokeWidth={2} />
      <span>{t('topbar.inboxPill')}</span>
      {count > 0 ? <span className={styles.pillCount}>{count}</span> : null}
    </Link>
  );
}

/** The search field: in the desktop top bar, or (`phone`) filling the phone header while it is open. */
function SearchBox({ phone = false }: { phone?: boolean }) {
  const { key, search, setSearch } = useProject();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const onBoard = pathname === `/p/${key}` || pathname.startsWith(`/p/${key}/tasks`);

  useEffect(() => {
    if (phone) return;
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
  }, [phone]);

  return (
    <form
      role="search"
      className={clsx(styles.search, phone && styles.searchPhone)}
      onSubmit={(event) => {
        event.preventDefault();
        if (!onBoard) navigate(`/p/${key}`);
        if (phone) inputRef.current?.blur();
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
        autoFocus={phone}
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setSearch('');
        }}
      />
      {search ? (
        <button
          type="button"
          className={styles.searchClear}
          onClick={() => setSearch('')}
          aria-label={t('topbar.searchClear')}
        >
          <Icon name="close" size={14} strokeWidth={2.2} />
        </button>
      ) : phone ? null : (
        <kbd className={styles.kbd} aria-hidden="true">
          /
        </kbd>
      )}
    </form>
  );
}

function Presence({ board, members }: { board: BoardView | undefined; members: MemberIndex }) {
  const { myHandle } = useProject();
  const online = (board?.members ?? []).filter(
    (member) => member.kind === 'human' && member.status === 'online',
  );
  if (online.length === 0) return null;
  const names = joinNames(online.map((member) => nameOf(member.handle, members, myHandle)));
  return (
    <span className={styles.presence}>
      <AvatarStack
        size="md"
        label={t('topbar.presence', { names })}
        members={online.map((member) => ({
          member,
          handle: member.handle,
          isMe: member.handle === myHandle,
        }))}
      />
    </span>
  );
}

/** The plan usage of every provider an AI member of the project runs on that has a measurable one. */
function planUsages(board: BoardView | undefined) {
  const providers = new Set(
    board?.members.flatMap((member) =>
      member.kind === 'ai' ? [member.provider ?? DEFAULT_AGENT_PROVIDER] : [],
    ) ?? [],
  );
  return [...providers].filter(hasPlanUsage).map((provider) => ({
    provider,
    usage: board?.planUsageByProvider[provider] ?? (provider === 'claude' ? board?.planUsage : null),
  }));
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
  const { key, openNewTask, openPause, can } = useProject();
  const canPause = can.pauseTeam && board !== undefined && openPauses(board.pause).length === 0;
  // The steps are listed at the top of this file.
  const compactNewTask = useMediaQuery(COMPACT_NEW_TASK_QUERY);
  const combinedMeters = useMediaQuery(COMBINED_PLAN_USAGE_QUERY);
  return (
    <header className={styles.topbar}>
      <ProjectSwitcher currentKey={key} currentName={board?.project.name ?? key} />
      <SearchBox />
      <span className={styles.spacer} />
      <span className={clsx(styles.hideNarrow, styles.meters)}>
        {combinedMeters ? (
          <CombinedPlanUsageMeter usages={planUsages(board)} pauseAbove={pauseAbove} />
        ) : (
          planUsages(board).map(({ provider, usage }) => (
            <PlanUsageMeter
              key={provider}
              provider={provider}
              usage={usage}
              pauseAbove={pauseAbove}
              variant="compact"
            />
          ))
        )}
      </span>
      <EngineIndicator />
      <MachineIndicator />
      <span className={styles.hideNarrow}>
        <Presence board={board} members={members} />
      </span>
      {canPause ? (
        <Button variant="secondary" icon="pause" className={styles.pauseButton} onClick={openPause}>
          {t('pause.button')}
        </Button>
      ) : null}
      <PmButton variant="bar" />
      <InboxPill count={inboxCount} />
      {can.createTasks ? (
        <Button
          variant="primary"
          icon="plus"
          iconOnly={compactNewTask}
          aria-label={compactNewTask ? t('topbar.newTask') : undefined}
          onClick={() => openNewTask()}
        >
          {compactNewTask ? undefined : t('topbar.newTask')}
        </Button>
      ) : null}
    </header>
  );
}

/**
 * Phone header: project chip, search, plan usage, new task, account. The inbox count lives on
 * the tab bar. Search opens over the whole row.
 */
export function MobileHeader({
  board,
  pauseAbove,
}: {
  board: BoardView | undefined;
  pauseAbove?: number | undefined;
}) {
  const { key, openNewTask, openPause, can, search, setSearch } = useProject();
  const [searching, setSearching] = useState(search !== '');
  const canPause = can.pauseTeam && board !== undefined && openPauses(board.pause).length === 0;
  if (searching) {
    return (
      <header className={styles.mobileHeader}>
        <SearchBox phone />
        <Button
          variant="ghost"
          size="lg"
          onClick={() => {
            setSearch('');
            setSearching(false);
          }}
        >
          {t('topbar.searchCancel')}
        </Button>
      </header>
    );
  }
  return (
    <header className={styles.mobileHeader}>
      <span className={styles.mobileProject}>
        <ProjectSwitcher currentKey={key} currentName={board?.project.name ?? key} compact />
      </span>
      <span className={styles.spacer} />
      <Button
        variant="ghost"
        size="lg"
        iconOnly
        icon="search"
        onClick={() => setSearching(true)}
        aria-label={t('topbar.searchOpen')}
      />
      <PlanUsageBadge
        usages={planUsages(board).map(({ usage }) => usage)}
        pauseAbove={pauseAbove}
        to={`/p/${key}/team`}
      />
      <EngineIndicator phone />
      <MachineIndicator phone />
      <PmButton variant="phone" />
      {can.createTasks ? (
        <Button
          variant="primary"
          size="md"
          iconOnly
          icon="plus"
          onClick={() => openNewTask()}
          aria-label={t('topbar.newTask')}
        />
      ) : null}
      <AccountMenu
        settingsPath={`/p/${key}/settings`}
        howWeWorkPath={can.readConfig ? `/p/${key}/how-we-work` : null}
        placement="below"
        onPause={canPause ? openPause : undefined}
      />
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
  const text =
    status === 'reconnecting'
      ? t('connection.reconnecting')
      : status === 'connecting' && slow
        ? t('connection.connecting')
        : null;
  if (!text) return null;
  return (
    <div className={styles.banner} role="status">
      <span className={styles.bannerSpinner} aria-hidden="true" />
      {text}
    </div>
  );
}
