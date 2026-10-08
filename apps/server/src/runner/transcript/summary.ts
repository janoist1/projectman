import { HANDOFF_SUMMARY_MAX, usesCodexCli } from '@projectman/shared';
import type { AgentProvider, ChatItem, HandoffSummary } from '@projectman/shared';
import { parseTranscript } from '../providers/claude/transcript';
import { parseCodexTranscript } from '../providers/codex/transcript';
import { parseGeminiTranscript } from '../providers/gemini/transcript';
import { textOf } from './chat-items';
import { rec, str } from './json';

/** The replies kept after a compaction summary. */
const REPLIES_AFTER_COMPACT = 4;
/** The replies kept when the conversation was never compacted. */
const LAST_REPLIES = 6;
/** The most of a compaction summary that is kept; the replies after it get the rest. */
const COMPACT_TEXT_MAX = 6000;
const REPLY_SEPARATOR = '\n\n---\n\n';
/** The time the Gemini parser gives an entry without one. */
const UNKNOWN_TIME = '1970-01-01T00:00:00.000Z';

interface Compact {
  text: string;
  at: string | null;
  /** Index of its line in the transcript. */
  line: number;
}

interface Reply {
  text: string;
  at: string | null;
}

/** `text` cut to at most `max` characters from its start, or from its end (`tail`), not inside a surrogate pair. */
function cut(text: string, max: number, side: 'head' | 'tail'): string {
  if (text.length <= max) return text;
  if (max <= 0) return '';
  if (side === 'head') {
    const end = /[\uD800-\uDBFF]/.test(text[max - 1]!) ? max - 1 : max;
    return text.slice(0, end);
  }
  const start = text.length - max;
  return text.slice(/[\uDC00-\uDFFF]/.test(text[start]!) ? start + 1 : start);
}

/** The last compaction summary of a Claude Code transcript or a Codex rollout, if it has one. */
function lastCompact(lines: string[], provider: AgentProvider): Compact | null {
  const marker = usesCodexCli(provider) ? '"compacted"' : 'isCompactSummary';
  for (let line = lines.length - 1; line >= 0; line -= 1) {
    const raw = lines[line]!;
    if (!raw.includes(marker)) continue;
    let entry;
    try {
      entry = rec(JSON.parse(raw));
    } catch {
      continue;
    }
    if (!entry) continue;
    const at = str(entry.timestamp);
    if (usesCodexCli(provider)) {
      // A top-level `compacted` line: `{timestamp, type: "compacted", payload: {message, ...}}`.
      if (entry.type !== 'compacted') continue;
      const text = str(rec(entry.payload)?.message)?.trim();
      if (text) return { text, at, line };
    } else {
      if (entry.type !== 'user' || entry.isCompactSummary !== true || entry.isSidechain === true) continue;
      const text = textOf(rec(entry.message)?.content, (item) => item.type === 'text').trim();
      if (text) return { text, at, line };
    }
  }
  return null;
}

function repliesOf(lines: string[], provider: AgentProvider): Reply[] {
  const text = lines.join('\n');
  const items: ChatItem[] =
    provider === 'gemini'
      ? parseGeminiTranscript(text)
      : usesCodexCli(provider)
        ? parseCodexTranscript(text)
        : parseTranscript(text);
  const replies: Reply[] = [];
  for (const item of items) {
    if (item.kind !== 'assistant_text') continue;
    const reply = item.text.trim();
    if (reply) replies.push({ text: reply, at: item.ts === UNKNOWN_TIME ? null : item.ts });
  }
  return replies;
}

/**
 * The newest of `replies` that fit `budget` characters with their separators, oldest first. The
 * oldest fall away; when even the newest is too long, its end is kept.
 */
function fitReplies(replies: Reply[], budget: number): Reply[] {
  const kept: Reply[] = [];
  let used = 0;
  for (let i = replies.length - 1; i >= 0; i -= 1) {
    const cost = replies[i]!.text.length + (kept.length > 0 ? REPLY_SEPARATOR.length : 0);
    if (used + cost > budget) break;
    kept.unshift(replies[i]!);
    used += cost;
  }
  if (kept.length === 0 && replies.length > 0 && budget > 1) {
    const newest = replies[replies.length - 1]!;
    kept.push({ ...newest, text: `…${cut(newest.text, budget - 1, 'tail')}` });
  }
  return kept;
}

/**
 * What the text of a transcript says about where its conversation stood (PM-342), for a member who
 * takes the card over without the conversation. Never throws: text it cannot make sense of gives null.
 */
export function summarizeTranscript(text: string, provider: AgentProvider): HandoffSummary | null {
  const lines = text.split('\n');
  const compact = provider === 'gemini' ? null : lastCompact(lines, provider);
  if (compact) {
    const head = cut(compact.text, COMPACT_TEXT_MAX, 'head');
    const compactText = head.length < compact.text.length ? `${head}…` : head;
    const replies = repliesOf(lines.slice(compact.line + 1), provider).slice(-REPLIES_AFTER_COMPACT);
    const budget = HANDOFF_SUMMARY_MAX - compactText.length - REPLY_SEPARATOR.length;
    const kept = fitReplies(replies, budget);
    return {
      source: 'compact',
      text: [compactText, ...kept.map((reply) => reply.text)].join(REPLY_SEPARATOR),
      at: kept[kept.length - 1]?.at ?? compact.at,
    };
  }
  const replies = repliesOf(lines, provider).slice(-LAST_REPLIES);
  const kept = fitReplies(replies, HANDOFF_SUMMARY_MAX);
  if (kept.length === 0) return null;
  return {
    source: 'last_replies',
    text: kept.map((reply) => reply.text).join(REPLY_SEPARATOR),
    at: kept[kept.length - 1]!.at,
  };
}
