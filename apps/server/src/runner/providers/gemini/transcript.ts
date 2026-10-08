import { createHash } from 'node:crypto';
import { mergeTokenUsage, type ChatItem } from '@projectman/shared';
import { compactInput, oneLine, toolSummary, TEAM_SEND_MESSAGE_TOOL } from '../../tools';
import { UserTurns, selfHandle, sentTeamMessage, undeliveredTeamMessage } from '../../transcript/chat-items';
import { rec, str, num } from '../../transcript/json';
import type { TranscriptLineParser, TranscriptParseResult } from '../types';
import { mapGeminiTool } from './hooks';

export class GeminiTranscriptParser implements TranscriptLineParser {
  private readonly turns: UserTurns;
  private readonly self: string | null;
  private readonly cwd: string | null;
  private readonly tools = new Map<number, { id: string; name: string }>();
  constructor(opts: { self?: string | null; cwd?: string | null; firstUserOrigin?: 'brief' | 'human' } = {}) {
    this.self = selfHandle(opts.self);
    this.cwd = opts.cwd ?? null;
    this.turns = new UserTurns(this.self, opts.firstUserOrigin);
  }
  parseLines(lines: Iterable<string>): TranscriptParseResult {
    const out: TranscriptParseResult = { items: [], interruptedAt: null, usage: [] };
    for (const line of lines) {
      let e;
      try {
        e = rec(JSON.parse(line));
      } catch {
        continue;
      }
      if (!e || e.type === 'EPHEMERAL_MESSAGE') continue;
      const id = `gm-${createHash('sha1').update(line).digest('hex').slice(0, 20)}`;
      const ts = str(e.created_at) ?? '1970-01-01T00:00:00.000Z';
      const content = str(e.content) ?? '';
      const step = num(e.step_index) ?? 0;
      if (e.type === 'USER_INPUT') {
        const text = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content)?.[1] ?? content;
        if (text) out.items.push(...this.turns.items(text, id, ts));
      } else if (e.type === 'PLANNER_RESPONSE') {
        if (content) out.items.push({ kind: 'assistant_text', id, ts, text: content });
        const calls = Array.isArray(e.tool_calls) ? e.tool_calls : [];
        calls.forEach((raw, index) => {
          const c = rec(raw);
          if (!c) return;
          const mapped = mapGeminiTool(str(c.name) ?? 'tool', rec(c.args) ?? {});
          const toolUseId = `${id}:${index}`;
          this.tools.set(step + index + 1, { id: toolUseId, name: mapped.name });
          if (this.tools.size > 2000) this.tools.delete(this.tools.keys().next().value!);
          if (mapped.name === TEAM_SEND_MESSAGE_TOOL)
            out.items.push(sentTeamMessage(rec(mapped.input) ?? {}, toolUseId, ts, this.self));
          else
            out.items.push({
              kind: 'tool_call',
              id: toolUseId,
              ts,
              toolUseId,
              name: mapped.name,
              input: compactInput(mapped.input),
              summary: toolSummary(mapped.name, mapped.input, this.cwd),
            });
        });
        const count = (v: unknown) => Math.max(0, Math.floor(num(v) ?? 0));
        const input = count(e.input_tokens),
          cacheRead = count(e.cache_read_tokens),
          output = count(e.output_tokens);
        out.usage!.push({
          model: str(e.model_name) ?? str(e.model) ?? 'gemini',
          scope: 'main',
          input,
          cacheRead,
          output,
          cacheWrite: 0,
        });
        out.contextTokens = input + cacheRead;
        out.turnEnded = calls.length === 0;
        out.turnAt = ts;
      } else if (e.type === 'GENERIC') {
        const tool = this.tools.get(step);
        const ok =
          e.status !== 'ERROR' && !e.error && !/^(?:error|failed|denied|tool call.*declined)/im.test(content);
        if (tool?.name === TEAM_SEND_MESSAGE_TOOL) {
          if (!ok) out.items.push(undeliveredTeamMessage(content, id, ts));
        } else
          out.items.push({
            kind: 'tool_result',
            id,
            ts,
            toolUseId: tool?.id ?? id,
            ok,
            summary: oneLine(content),
          });
      }
    }
    out.usage = mergeTokenUsage(out.usage!);
    return out;
  }
}
export function parseGeminiTranscript(
  text: string,
  opts: ConstructorParameters<typeof GeminiTranscriptParser>[0] = {},
): ChatItem[] {
  return new GeminiTranscriptParser(opts).parseLines(text.split(/\r?\n/)).items;
}
