import type { TeamTool, TeamToolGroup } from './kit';
export {
  TEAM_TOOL_NAMES,
  toolOutputText,
  type TeamToolName,
  type ToolRun,
  type ToolImage,
  type ToolOutput,
  type TeamTool,
  type TeamToolGroup,
} from './kit';
import { MEMBER_TOOL_GROUP } from './members';
import { TASK_TOOL_GROUP } from './tasks';
import { ATTACHMENT_TOOL_GROUP } from './attachments';
import { MERGE_TOOL_GROUP } from './merges';
import { PROJECT_DOC_TOOL_GROUP } from './project-docs';
import { SYSTEM_FEEDBACK_TOOL_GROUP } from './system-feedback';
import { HISTORY_TOOL_GROUP } from './history';
import { FEEDBACK_TOOL_GROUP } from './feedback';
import { GITHUB_TOOL_GROUP } from './github';
import { SCREENSHOT_TOOL_GROUP } from './full-tests';
import { BOUNDARY_TOOL_GROUP } from './boundary';
import { RELEASE_TOOL_GROUP } from './releases';
import { OPERATOR_TOOL_GROUP } from './operator';
import { INBOX_TOOL_GROUP } from './inbox';
import { MESSAGE_TOOL_GROUP } from './messages';
import { ADMISSION_TOOL_GROUP } from './admission';
import { WATCHER_TOOL_GROUP } from './watchers';
import { OPERATOR_QUEUE_TOOL_GROUP } from './operator-queue';
import { SESSION_TOOL_GROUP } from './sessions';
/**
 * Server-level instructions, sent once at initialization. Claude Code appends them to the
 * system prompt; Codex (0.159.1) shows them to the model as the description of the server's
 * tool namespace. Every session's system prompt already has the team rules ("How the team
 * works"), so they only say what the server is and where the rules are.
 */
export const TEAM_INSTRUCTIONS =
  'Team tools connect you with your team in projectman: humans and other AI members. How the team ' +
  'uses them is in your instructions under "How the team works"; each tool says when to use it.';

/** Every module's team tools (PM-592). A new tool goes into its module's group (mcp/<module>/tools.ts), never into this file. */
export const TEAM_TOOL_GROUPS: readonly TeamToolGroup[] = [
  MEMBER_TOOL_GROUP,
  TASK_TOOL_GROUP,
  ATTACHMENT_TOOL_GROUP,
  MERGE_TOOL_GROUP,
  FEEDBACK_TOOL_GROUP,
  GITHUB_TOOL_GROUP,
  SCREENSHOT_TOOL_GROUP,
  BOUNDARY_TOOL_GROUP,
  RELEASE_TOOL_GROUP,
  OPERATOR_TOOL_GROUP,
  PROJECT_DOC_TOOL_GROUP,
  SYSTEM_FEEDBACK_TOOL_GROUP,
  HISTORY_TOOL_GROUP,
  INBOX_TOOL_GROUP,
  MESSAGE_TOOL_GROUP,
  ADMISSION_TOOL_GROUP,
  WATCHER_TOOL_GROUP,
  OPERATOR_QUEUE_TOOL_GROUP,
  SESSION_TOOL_GROUP,
];
export const TEAM_TOOLS: readonly TeamTool[] = TEAM_TOOL_GROUPS.flatMap((group) => group.tools);
