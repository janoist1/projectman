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

const toolCategories = ['read', 'search', 'edit', 'command', 'web', 'team', 'other'] as const;

type ToolCategory = (typeof toolCategories)[number];

function toolCategory(name: string | null): ToolCategory {
  if (!name) return 'other';
  if (name.startsWith('mcp__team__')) return 'team';
  switch (name) {
    case 'Read':
      return 'read';
    case 'Grep':
    case 'Glob':
    case 'LS':
      return 'search';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit';
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return 'command';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    default:
      return 'other';
  }
}

/**
 * One line for a run of tool calls: "8 lépés · 3 fájl olvasva, 5 parancs". Files are counted by
 * path, so reading one file three times is one file; failures come last so a closed group shows them.
 */
export function summarizeToolRows(rows: readonly ToolRow[]): string {
  const counts = new Map<ToolCategory, number>();
  const files = new Map<ToolCategory, Set<string>>();
  let failed = 0;
  for (const row of rows) {
    const category = toolCategory(row.call?.name ?? null);
    const path = row.call?.summary;
    if ((category === 'read' || category === 'edit') && path) {
      const seen = files.get(category) ?? new Set<string>();
      seen.add(path);
      files.set(category, seen);
    } else {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    if (row.result && !row.result.ok) failed += 1;
  }
  const parts: string[] = [];
  for (const category of toolCategories) {
    const count = (counts.get(category) ?? 0) + (files.get(category)?.size ?? 0);
    if (count > 0) parts.push(t(`session.chat.toolKinds.${category}`, { count }));
  }
  if (failed > 0) parts.push(t('session.chat.toolFailedCount', { count: failed }));
  return [t('session.chat.toolSteps', { count: rows.length }), parts.join(', ')].filter(Boolean).join(' · ');
}

/**
 * The outcome of a tool call in Hungarian. The runner sends short English words ("Edited",
 * "397 lines"); they are written from the tool's kind here. Anything else (a command's first
 * output line, an error text) is the tool's own text and stays as it is.
 */
export function toolResultText(call: ToolCall | null, result: ToolResult): string {
  const text = result.summary;
  const category = toolCategory(call?.name ?? null);
  if (!result.ok) return text === 'Failed' ? '' : text;
  const lines = /^(\d+) lines$/.exec(text);
  const files = /^(\d+) files$/.exec(text);
  if (category === 'read' && lines) return t('session.chat.result.lines', { count: lines[1] ?? '' });
  if (category === 'read' && text === 'Read') return t('session.chat.result.read');
  if (category === 'edit' && text === 'Edited') return t('session.chat.result.edited');
  if (category === 'edit' && text === 'Created') return t('session.chat.result.created');
  if (category === 'edit' && text === 'Updated') return t('session.chat.result.updated');
  if (category === 'search' && files) return t('session.chat.result.files', { count: files[1] ?? '' });
  if (category === 'command' && text === 'Interrupted') return t('session.chat.result.interrupted');
  if (text === 'Done') return t('session.chat.result.done');
  return text;
}

/** Icon and label of a tool call row. */
export function toolPresentation(call: ToolCall | null): { icon: IconName; label: string } {
  if (!call) return { icon: 'tool', label: t('session.tools.other') };
  return toolPresentationFor(call.name, call.summary);
}
