import { TEAM_MESSAGE_PREFIX_RE } from '@projectman/shared';
import type { ChatItem } from '@projectman/shared';
import type { IconName } from '../components/Icon';
import { t } from '../i18n/t';

type ToolCall = Extract<ChatItem, { kind: 'tool_call' }>;
type ToolResult = Extract<ChatItem, { kind: 'tool_result' }>;
type TeamMessageItem = Extract<ChatItem, { kind: 'team_message' }>;

export interface ToolRow {
  id: string;
  call: ToolCall | null;
  result: ToolResult | null;
}

export type ChatBlock =
  | { type: 'user'; id: string; ts: string; item: Extract<ChatItem, { kind: 'user_text' }> }
  | { type: 'assistant'; id: string; ts: string; item: Extract<ChatItem, { kind: 'assistant_text' }> }
  | { type: 'tools'; id: string; ts: string; rows: ToolRow[] }
  | { type: 'team'; id: string; ts: string; item: TeamMessageItem }
  | { type: 'note'; id: string; ts: string; item: Extract<ChatItem, { kind: 'system_note' }> };

/**
 * Turns an injected team message typed into the session ("[team message from qa about
 * AC-21]\n…") into a team message item, in case the transcript parser left it as user text.
 */
function asTeamMessage(
  item: Extract<ChatItem, { kind: 'user_text' }>,
  sessionMember: string | null,
): TeamMessageItem | null {
  const match = TEAM_MESSAGE_PREFIX_RE.exec(item.text);
  if (!match) return null;
  return {
    id: item.id,
    ts: item.ts,
    kind: 'team_message',
    direction: 'in',
    from: match[1] ?? '',
    to: sessionMember ? [sessionMember] : [],
    text: item.text.slice(match[0].length),
  };
}

/**
 * Groups a session's chat for display: consecutive tool calls and results collapse into
 * one compact block, and each result is paired with its call (even if other items came
 * in between).
 */
export function groupChatItems(items: readonly ChatItem[], sessionMember: string | null = null): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  const rowsByToolUse = new Map<string, ToolRow>();

  for (const item of items) {
    if (item.kind === 'tool_call' || item.kind === 'tool_result') {
      if (item.kind === 'tool_result') {
        const row = rowsByToolUse.get(item.toolUseId);
        if (row && !row.result) {
          row.result = item;
          continue;
        }
      }
      let last = blocks[blocks.length - 1];
      if (!last || last.type !== 'tools') {
        last = { type: 'tools', id: `tools-${item.id}`, ts: item.ts, rows: [] };
        blocks.push(last);
      }
      const row: ToolRow =
        item.kind === 'tool_call'
          ? { id: item.id, call: item, result: null }
          : { id: item.id, call: null, result: item };
      last.rows.push(row);
      if (item.kind === 'tool_call') rowsByToolUse.set(item.toolUseId, row);
      continue;
    }
    switch (item.kind) {
      case 'user_text': {
        const team = asTeamMessage(item, sessionMember);
        blocks.push(
          team
            ? { type: 'team', id: item.id, ts: item.ts, item: team }
            : { type: 'user', id: item.id, ts: item.ts, item },
        );
        break;
      }
      case 'assistant_text':
        blocks.push({ type: 'assistant', id: item.id, ts: item.ts, item });
        break;
      case 'team_message':
        blocks.push({ type: 'team', id: item.id, ts: item.ts, item });
        break;
      case 'system_note':
        blocks.push({ type: 'note', id: item.id, ts: item.ts, item });
        break;
    }
  }
  return blocks;
}

const toolLabelKeys = [
  'Read',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'Bash',
  'BashOutput',
  'KillShell',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Task',
] as const;

type KnownTool = (typeof toolLabelKeys)[number];

function isKnownTool(name: string): name is KnownTool {
  return (toolLabelKeys as readonly string[]).includes(name);
}

/** Icon and label of a tool by name: "Olvasás", "Parancs", "Git", "Csapat". */
export function toolPresentationFor(name: string, summary = ''): { icon: IconName; label: string } {
  if (name === 'Bash' && /^git\s/.test(summary)) return { icon: 'commit', label: t('session.tools.git') };
  if (name === 'Bash' && /^gh\s/.test(summary)) return { icon: 'prOpen', label: t('session.tools.git') };
  if (name.startsWith('mcp__team__')) return { icon: 'team', label: t('session.tools.team') };
  if (name.startsWith('mcp__')) return { icon: 'tool', label: t('session.tools.mcp') };
  const label = isKnownTool(name) ? t(`session.tools.${name}`) : name;
  switch (name) {
    case 'Read':
      return { icon: 'doc', label };
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return { icon: 'pencil', label };
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return { icon: 'terminal', label };
    case 'Grep':
    case 'Glob':
    case 'LS':
      return { icon: 'search', label };
    case 'WebFetch':
    case 'WebSearch':
      return { icon: 'globe', label };
    case 'TodoWrite':
      return { icon: 'list', label };
    case 'Task':
      return { icon: 'sparkle', label };
    default:
      return { icon: 'tool', label };
  }
}

/** Icon and label of a tool call row. */
export function toolPresentation(call: ToolCall | null): { icon: IconName; label: string } {
  if (!call) return { icon: 'tool', label: t('session.tools.other') };
  return toolPresentationFor(call.name, call.summary);
}
