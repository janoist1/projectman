/**
 * Text written for AI members to read: task links, attachments, timeline events and shortened free text.
 * One implementation for the context pack (src/context: the kick-off brief) and the team tools
 * (src/mcp: get_task and other results), which differ only in their TextStyle. Pure functions,
 * no dependencies on other server modules.
 */
export { describeAttachment, formatBytes } from './attachments';
export {
  cardQuestionLines,
  cardWorkerLines,
  stateText,
  type CardQuestionText,
  type CardWorkerText,
} from './card-thread';
export { focusPlaceText } from './focus';
export { describeLink, linkTarget, numberedRef } from './links';
export { describeRelatedCard, relationLines, relationPhrase } from './relations';
export { relationNoticeText, type RelationNoticeRelation } from './relation-notice';
export { roleLabel } from './role';
export { describeRepo, type TaskRepoInfo } from './repo';
export { describeTheme, themeCardLines, themeProgressText, themeState } from './theme';
export { formatTimestamp, oneLine, PLAIN_STYLE, truncate, type TextStyle } from './text';
export {
  describeEvent,
  eventFullText,
  recentTimeline,
  timelineLine,
  type RecentTimeline,
  type TimelineOptions,
} from './timeline';
