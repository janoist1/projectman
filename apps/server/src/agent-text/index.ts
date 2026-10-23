/**
 * Text written for AI members to read: task links, attachments, timeline events and shortened free text.
 * One implementation for the context pack (src/context: the kick-off brief) and the team tools
 * (src/mcp: get_task and other results), which differ only in their TextStyle. Pure functions,
 * no dependencies on other server modules.
 */
export { describeAttachment, formatBytes } from './attachments';
export { cardQuestionLines, cardWorkerLines, stateText } from './card-thread';
export { focusPlaceText } from './focus';
export { describeLink, linkTarget } from './links';
export { relationLines, relationPhrase } from './relations';
export { relationNoticeText, type RelationNoticeRelation } from './relation-notice';
export { operatorQueueReminderText, operatorQueueText } from './operator-queue';
export { partsLeftText } from './parts-left';
export { roleLabel } from './role';
export { collectorNotReadyText, startOfferText } from './start-offer';
export { describeTaskWait, taskWaitShort } from './task-wait';
export { describeRepo } from './repo';
export { describeTheme, themeCardLines, themeProgressText, themeState } from './theme';
export { formatTimestamp, oneLine, truncate, type TextStyle } from './text';
export { describeEvent, eventFullText, recentTimeline, timelineLine } from './timeline';

export {
  startReason,
  reaskHint,
  QUESTION_NOTICE_LIMIT,
  ANSWER_NOTICE_LIMIT,
  QUESTION_CLOSE_REASONS,
} from './message-notices';
