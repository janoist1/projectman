import { useMemo } from 'react';
import { matchPath, useLocation } from 'react-router';
import { CardView, UiLocation, uiPlaceRefusal } from '@projectman/shared';
import type { HumanAccess, UiPlace } from '@projectman/shared';
import { t } from '../../i18n/t';

/** What the viewer's board knows: a place that names a card or a member outside it is not available. */
export interface PlaceKnowledge {
  titles: ReadonlyMap<string, string>;
  names: ReadonlyMap<string, string>;
}

export type PlaceState = 'go' | 'here' | 'unavailable';

/** The card route under the board, the inbox or the map; the splat is the card's view. */
const CARD_ROUTES = [
  { page: 'board', pattern: '/p/:projectKey/tasks/:taskKey/*' },
  { page: 'inbox', pattern: '/p/:projectKey/inbox/tasks/:taskKey/*' },
  { page: 'map', pattern: '/p/:projectKey/map/tasks/:taskKey/*' },
] as const;

/** The other pages, by their path below `/p/:projectKey`. */
const PAGE_ROUTES: readonly {
  pattern: string;
  page: UiLocation['page'];
  /** The route parameters that go into the marker, by their field. */
  fields?: Partial<Record<'handle' | 'markId' | 'sessionId' | 'section', string>>;
}[] = [
  { pattern: '/p/:projectKey', page: 'board' },
  { pattern: '/p/:projectKey/inbox', page: 'inbox' },
  { pattern: '/p/:projectKey/map', page: 'map' },
  { pattern: '/p/:projectKey/team', page: 'team' },
  { pattern: '/p/:projectKey/team/:handle', page: 'member', fields: { handle: 'handle' } },
  { pattern: '/p/:projectKey/team/:handle/context', page: 'member_context', fields: { handle: 'handle' } },
  { pattern: '/p/:projectKey/messages', page: 'messages' },
  { pattern: '/p/:projectKey/messages/all', page: 'messages' },
  { pattern: '/p/:projectKey/messages/with/:handle', page: 'messages', fields: { handle: 'handle' } },
  { pattern: '/p/:projectKey/feedback', page: 'feedback' },
  { pattern: '/p/:projectKey/feedback/:markId', page: 'feedback', fields: { markId: 'markId' } },
  { pattern: '/p/:projectKey/notifications', page: 'notifications' },
  { pattern: '/p/:projectKey/how-we-work', page: 'how_we_work' },
  { pattern: '/p/:projectKey/sessions', page: 'sessions' },
  { pattern: '/p/:projectKey/sessions/:sessionId', page: 'session', fields: { sessionId: 'sessionId' } },
  { pattern: '/p/:projectKey/settings', page: 'settings' },
  { pattern: '/p/:projectKey/settings/:section', page: 'settings', fields: { section: 'section' } },
];

/**
 * Where the writer is, as the typed marker that goes with a message (PM-1071). A path of an unknown
 * shape, or a part that does not parse, is `other` (or left out): the marker never carries free text.
 * `dismissedCard` is a card the writer took off the message: only the page is sent then.
 */
export function uiLocationOf(pathname: string, dismissedCard: string | null = null): UiLocation {
  for (const route of CARD_ROUTES) {
    const match = matchPath({ path: route.pattern }, pathname);
    if (!match) continue;
    const taskKey = match.params.taskKey;
    if (taskKey === dismissedCard) return { page: route.page };
    const view = CardView.safeParse(match.params['*']?.split('/')[0] || 'card');
    const parsed = UiLocation.safeParse({
      page: route.page,
      taskKey,
      ...(view.success ? { view: view.data } : {}),
    });
    return parsed.success ? parsed.data : { page: route.page };
  }
  for (const route of PAGE_ROUTES) {
    const match = matchPath({ path: route.pattern, end: true }, pathname);
    if (!match) continue;
    const fields = Object.fromEntries(
      Object.entries(route.fields ?? {}).map(([field, param]) => [field, match.params[param]]),
    );
    const parsed = UiLocation.safeParse({ page: route.page, ...fields });
    // Keep the page when only an identifier did not parse (an unknown settings section, a mark id).
    return parsed.success ? parsed.data : route.fields ? { page: route.page } : { page: 'other' };
  }
  return { page: 'other' };
}

/** The writer's place, as it is now. */
export function useUiLocation(dismissedCard: string | null): UiLocation {
  const { pathname } = useLocation();
  return useMemo(() => uiLocationOf(pathname, dismissedCard), [pathname, dismissedCard]);
}

/** The address of the place, from the place the writer is at now (a card opens over the page it is on). */
export function placePath(projectKey: string, place: UiPlace, from: UiLocation): string {
  const base = `/p/${projectKey}`;
  switch (place.page) {
    case 'card': {
      const over = from.page === 'inbox' ? '/inbox' : from.page === 'map' ? '/map' : '';
      const view = place.view && place.view !== 'card' ? `/${place.view}` : '';
      return `${base}${over}/tasks/${place.taskKey}${view}`;
    }
    case 'board':
      return base;
    case 'member':
      return `${base}/team/${place.handle}`;
    case 'how_we_work':
      return `${base}/how-we-work`;
    case 'settings':
      return `${base}/settings${place.section ? `/${place.section}` : ''}`;
    default:
      return `${base}/${place.page}`;
  }
}

/** The name on the button: the page's name in the navigation, the section, the member, or the card. */
export function placeLabel(place: UiPlace, known: PlaceKnowledge): string {
  switch (place.page) {
    case 'card':
      return `${place.taskKey} · ${known.titles.get(place.taskKey!) ?? ''}`.trim();
    case 'board':
      return t('nav.board');
    case 'inbox':
      return t('nav.inbox');
    case 'map':
      return t('nav.map');
    case 'team':
      return t('nav.team');
    case 'member':
      return `${t('nav.team')} › ${known.names.get(place.handle!) ?? place.handle}`;
    case 'messages':
      return t('nav.messages');
    case 'feedback':
      return t('nav.feedback');
    case 'notifications':
      return t('nav.notifications');
    case 'how_we_work':
      return t('nav.howWeWork');
    case 'sessions':
      return t('operator.place.sessions');
    case 'settings':
      return place.section
        ? `${t('nav.settings')} › ${t(`settings.nav.${place.section}`)}`
        : t('nav.settings');
  }
}

/**
 * What the button does for this viewer: not available (a part they do not see, a card or member gone),
 * already here, or a way there.
 */
export function placeState(
  place: UiPlace,
  from: UiLocation,
  access: HumanAccess | undefined,
  known: PlaceKnowledge,
): PlaceState {
  if (access === undefined || uiPlaceRefusal(place, access)) return 'unavailable';
  if (place.page === 'card') {
    if (!known.titles.has(place.taskKey!)) return 'unavailable';
    return from.taskKey === place.taskKey && (!place.view || place.view === (from.view ?? 'card'))
      ? 'here'
      : 'go';
  }
  if (place.page === 'member' && !known.names.has(place.handle!)) return 'unavailable';
  if (from.taskKey !== undefined) return 'go';
  switch (place.page) {
    case 'member':
      return from.page === 'member' && from.handle === place.handle ? 'here' : 'go';
    case 'sessions':
      return from.page === 'sessions' ? 'here' : 'go';
    case 'settings':
      return from.page === 'settings' && (place.section === undefined || place.section === from.section)
        ? 'here'
        : 'go';
    default:
      return from.page === place.page ? 'here' : 'go';
  }
}
