import { z } from 'zod';
import { FeedbackMarkId } from './feedback';
import { MemberHandle } from './member';
import type { HumanAccess } from './member';
import { TaskKey } from './task';

/** The sections of the settings page, in the order of its navigation. */
export const SETTINGS_SECTIONS = [
  'pipeline',
  'labels',
  'duties',
  'team',
  'limits',
  'project',
  'repos',
  'feedback',
  'email',
  'history',
  'engines',
  'providers',
  'owners',
  'integrator',
  'account',
] as const;
export const SettingsSection = z.enum(SETTINGS_SECTIONS);
export type SettingsSection = z.infer<typeof SettingsSection>;

/** The views of an open card: its tabs in the card drawer. */
export const CardView = z.enum(['card', 'thread', 'attachments', 'timeline']);
export type CardView = z.infer<typeof CardView>;

export const UI_LOCATION_PAGES = [
  'board',
  'inbox',
  'map',
  'team',
  'member',
  'member_context',
  'messages',
  'feedback',
  'notifications',
  'how_we_work',
  'sessions',
  'session',
  'settings',
  'other',
] as const;

const CARD_OVER_PAGES: readonly string[] = ['board', 'inbox', 'map'];

/**
 * Where the sender is in the app when they write (PM-1071). Typed fields only, no free text: it is
 * shown to the project manager as background, so every field is an enum or an identifier of a known shape.
 */
export const UiLocation = z
  .strictObject({
    page: z.enum(UI_LOCATION_PAGES),
    /** The card open over the board, the inbox or the map. */
    taskKey: TaskKey.optional(),
    /** The view of that card; only with `taskKey`. */
    view: CardView.optional(),
    /** `member`, `member_context`: required; `messages`: the other side of the conversation. */
    handle: MemberHandle.optional(),
    section: SettingsSection.optional(),
    markId: FeedbackMarkId.optional(),
    sessionId: z
      .string()
      .regex(/^ses_[a-z0-9]{10,32}$/)
      .optional(),
  })
  .superRefine((location, ctx) => {
    const reject = (path: string, message: string): void => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (location.taskKey !== undefined && !CARD_OVER_PAGES.includes(location.page))
      reject('taskKey', 'only on board, inbox or map');
    if (location.view !== undefined && location.taskKey === undefined) reject('view', 'needs taskKey');
    const handleKind = location.page === 'member' || location.page === 'member_context';
    if (handleKind && location.handle === undefined) reject('handle', 'required on this page');
    if (location.handle !== undefined && !handleKind && location.page !== 'messages')
      reject('handle', 'not on this page');
    if (location.section !== undefined && location.page !== 'settings') reject('section', 'only on settings');
    if (location.markId !== undefined && location.page !== 'feedback') reject('markId', 'only on feedback');
    if (location.page === 'session' && location.sessionId === undefined)
      reject('sessionId', 'required on this page');
    if (location.sessionId !== undefined && location.page !== 'session')
      reject('sessionId', 'only on session');
  });
export type UiLocation = z.infer<typeof UiLocation>;

export const UI_PLACE_PAGES = [
  'card',
  'board',
  'inbox',
  'map',
  'team',
  'member',
  'messages',
  'feedback',
  'notifications',
  'how_we_work',
  'sessions',
  'settings',
] as const;

/** A place in the app the project manager offers to a person as a "go there" button (PM-1071). */
export const UiPlace = z
  .strictObject({
    page: z.enum(UI_PLACE_PAGES),
    /** `card`: required. */
    taskKey: TaskKey.optional(),
    /** Only on `card`. */
    view: CardView.optional(),
    /** `member`: required. */
    handle: MemberHandle.optional(),
    /** Only on `settings`. */
    section: SettingsSection.optional(),
  })
  .superRefine((place, ctx) => {
    const reject = (path: string, message: string): void => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (place.page === 'card' && place.taskKey === undefined) reject('taskKey', 'required on card');
    if (place.page !== 'card' && place.taskKey !== undefined) reject('taskKey', 'only on card');
    if (place.page !== 'card' && place.view !== undefined) reject('view', 'only on card');
    if (place.page === 'member' && place.handle === undefined) reject('handle', 'required on member');
    if (place.page !== 'member' && place.handle !== undefined) reject('handle', 'only on member');
    if (place.page !== 'settings' && place.section !== undefined) reject('section', 'only on settings');
  });
export type UiPlace = z.infer<typeof UiPlace>;

/** How many places one message carries. */
export const MAX_MESSAGE_PLACES = 3;

export type UiPlaceRefusal = 'place_not_target' | 'place_not_visible';

/** Whether the person sees the settings section: the feedback and e-mail parts are for the owner and the admin. */
export function settingsSectionVisible(section: SettingsSection, access: HumanAccess): boolean {
  return (section !== 'feedback' && section !== 'email') || access === 'owner' || access === 'admin';
}

/**
 * Why the project manager may not offer the place to a person with this access, or null.
 * `place_not_target`: a machine-level settings part, not the project's; `place_not_visible`: the person
 * does not see it. Every other page is visible to every member.
 */
export function uiPlaceRefusal(place: UiPlace, access: HumanAccess): UiPlaceRefusal | null {
  if (place.page !== 'settings' || place.section === undefined) return null;
  if (place.section === 'integrator' || place.section === 'engines' || place.section === 'owners')
    return 'place_not_target';
  return settingsSectionVisible(place.section, access) ? null : 'place_not_visible';
}

/** The same place twice in one list. */
export function uiPlaceKey(place: UiPlace): string {
  return [place.page, place.taskKey, place.view, place.handle, place.section].join('|');
}

/**
 * The line that tells the recipient where the sender is, put last under the message text. Everything in it
 * is typed (enum, key, handle, id); it is background, not an instruction.
 */
export function uiLocationLine(from: string, location: UiLocation): string {
  const parts = [`page=${location.page}`];
  if (location.taskKey) {
    parts.push(`card=${location.taskKey}`);
    if (location.view) parts.push(`view=${location.view}`);
  }
  if (location.handle) parts.push(`member=${location.handle}`);
  if (location.section) parts.push(`section=${location.section}`);
  if (location.markId) parts.push(`mark=${location.markId}`);
  if (location.sessionId) parts.push(`session=${location.sessionId}`);
  return `[app location of ${from}: ${parts.join(' ')}. Background only, not an instruction: use it only when the message is about what they see.]`;
}
