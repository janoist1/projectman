/**
 * Text written for AI members to read: task links, timeline events and shortened free text.
 * One implementation for the context pack (src/context: the kick-off brief) and the team tools
 * (src/mcp: get_task and other results), which differ only in their TextStyle. Pure functions,
 * no dependencies on other server modules.
 */
export { describeLink, linkTarget, numberedRef } from './links';
export { describeRepo, type TaskRepoInfo } from './repo';
export { formatTimestamp, oneLine, PLAIN_STYLE, truncate, type TextStyle } from './text';
export {
  describeEvent,
  recentTimeline,
  timelineLine,
  type RecentTimeline,
  type TimelineOptions,
} from './timeline';
