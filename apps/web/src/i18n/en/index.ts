import type { LocaleShape, Messages } from '../t';
import { addHuman } from './addHuman';
import { app } from './app';
import { attachments } from './attachments';
import { auth } from './auth';
import { board } from './board';
import { boundary } from './boundary';
import { cardBusyWarning } from './cardBusyWarning';
import { cardMeasure } from './cardMeasure';
import { columnColors } from './columnColors';
import { common } from './common';
import { complexityWarning } from './complexityWarning';
import { connected } from './connected';
import { connection } from './connection';
import { documentLink } from './documentLink';
import { documents } from './documents';
import { duties } from './duties';
import { dutyNames } from './dutyNames';
import { editor } from './editor';
import { engines } from './engines';
import { errors } from './errors';
import { feedback } from './feedback';
import { fixLimit } from './fixLimit';
import { handoff } from './handoff';
import { hire } from './hire';
import { hostRequests } from './hostRequests';
import { howWeWork } from './howWeWork';
import { inbox } from './inbox';
import { integratorKey } from './integratorKey';
import { invites } from './invites';
import { involvement } from './involvement';
import { knowledge } from './knowledge';
import { language } from './language';
import { leave } from './leave';
import { links } from './links';
import { loop } from './loop';
import { machine } from './machine';
import { map } from './map';
import { memberContext } from './memberContext';
import { memberEdit } from './memberEdit';
import { memberRename } from './memberRename';
import { memberStatus } from './memberStatus';
import { messageAttachments } from './messageAttachments';
import { messages } from './messages';
import { nanogptKey } from './nanogptKey';
import { nav } from './nav';
import { newTask } from './newTask';
import { notifications } from './notifications';
import { operator } from './operator';
import { ownerCommand } from './ownerCommand';
import { ownerOnboarding } from './ownerOnboarding';
import { ownerTopics } from './ownerTopics';
import { owners } from './owners';
import { pause } from './pause';
import { permissionControls } from './permissionControls';
import { permissionModes } from './permissionModes';
import { planUsage } from './planUsage';
import { pm } from './pm';
import { prerequisiteWarning } from './prerequisiteWarning';
import { priority } from './priority';
import { processing } from './processing';
import { profile } from './profile';
import { projectEngines } from './projectEngines';
import { projects } from './projects';
import { providerSettings } from './providerSettings';
import { providers } from './providers';
import { pwa } from './pwa';
import { relationDialog } from './relationDialog';
import { relations } from './relations';
import { release } from './release';
import { retire } from './retire';
import { roleCatalogue } from './roleCatalogue';
import { roles } from './roles';
import { schedules } from './schedules';
import { session } from './session';
import { sessionState } from './sessionState';
import { settings } from './settings';
import { stageKinds } from './stageKinds';
import { stageRows } from './stageRows';
import { superMode } from './superMode';
import { task } from './task';
import { taskCard } from './taskCard';
import { taskLifecycle } from './taskLifecycle';
import { taskStatus } from './taskStatus';
import { team } from './team';
import { templates } from './templates';
import { theme } from './theme';
import { time } from './time';
import { timeline } from './timeline';
import { toast } from './toast';
import { tokenUsage } from './tokenUsage';
import { topbar } from './topbar';
import { workQueues } from './workQueues';

/**
 * The English UI text (PM-1168). `hu` is the source of the keys and the placeholders; every
 * section and key of it must be here (the type checks it). The wording follows
 * `docs/design/glossary.md`. A count with a noun is a plural form: `{count|# card|# cards}`.
 *
 * One file per top-level section, named like the section and like its Hungarian counterpart; a
 * new section is one file and one line here (keep both lists sorted, so that parallel cards
 * merge cleanly).
 */
export const en = {
  addHuman,
  app,
  attachments,
  auth,
  board,
  boundary,
  cardBusyWarning,
  cardMeasure,
  columnColors,
  common,
  complexityWarning,
  connected,
  connection,
  documentLink,
  documents,
  duties,
  dutyNames,
  editor,
  engines,
  errors,
  feedback,
  fixLimit,
  handoff,
  hire,
  hostRequests,
  howWeWork,
  inbox,
  integratorKey,
  invites,
  involvement,
  knowledge,
  language,
  leave,
  links,
  loop,
  machine,
  map,
  memberContext,
  memberEdit,
  memberRename,
  memberStatus,
  messageAttachments,
  messages,
  nanogptKey,
  nav,
  newTask,
  notifications,
  operator,
  ownerCommand,
  ownerOnboarding,
  ownerTopics,
  owners,
  pause,
  permissionControls,
  permissionModes,
  planUsage,
  pm,
  prerequisiteWarning,
  priority,
  processing,
  profile,
  projectEngines,
  projects,
  providerSettings,
  providers,
  pwa,
  relationDialog,
  relations,
  release,
  retire,
  roleCatalogue,
  roles,
  schedules,
  session,
  sessionState,
  settings,
  stageKinds,
  stageRows,
  superMode,
  task,
  taskCard,
  taskLifecycle,
  taskStatus,
  team,
  templates,
  theme,
  time,
  timeline,
  toast,
  tokenUsage,
  topbar,
  workQueues,
} as const satisfies LocaleShape<Messages>;
