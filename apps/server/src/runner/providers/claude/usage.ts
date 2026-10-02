import { mergeTokenUsage, type TokenUsage, type TokenUsageScope } from '@projectman/shared';
import { num, rec, str } from '../../transcript/json';

/**
 * Token usage in Claude Code transcript entries (PM-178). An assistant entry carries
 * `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
 * `cache_creation_input_tokens`) beside `message.model`. One API response is written as several
 * entries with the same `message.id` (one per content block), each with the response's usage:
 * it is counted once per id. Earlier entries of a response may carry a placeholder output count,
 * so a later, larger one adds the difference. API error entries and the `<synthetic>` model
 * (messages Claude Code writes itself) used no tokens.
 */
export class ClaudeUsageCounter {
  /** Message id -> output tokens counted for it. */
  private readonly counted = new Map<string, number>();
  /** The context of the latest step of the main conversation seen since `takeContext`. */
  private context: number | null = null;

  /** The context of the latest main-conversation step added since the last call; null if none. */
  takeContext(): number | null {
    const context = this.context;
    this.context = null;
    return context;
  }

  /** What `entry` adds to the usage, or null when nothing (not a response, or counted already). */
  add(value: unknown, scope: TokenUsageScope): TokenUsage | null {
    const entry = rec(value);
    if (!entry || entry.type !== 'assistant' || entry.isApiErrorMessage === true) return null;
    const message = rec(entry.message);
    const usage = rec(message?.usage);
    const model = str(message?.model);
    if (!usage || !model || model === '<synthetic>') return null;
    const output = count(usage.output_tokens);
    // The context of a step is what it read in: its input, with the cache's part of it (PM-213).
    if (scope === 'main') {
      this.context =
        count(usage.input_tokens) +
        count(usage.cache_read_input_tokens) +
        count(usage.cache_creation_input_tokens);
    }
    const id = str(message?.id) ?? str(entry.uuid);
    const before = id === null ? undefined : this.counted.get(id);
    if (id !== null) this.counted.set(id, Math.max(output, before ?? 0));
    if (before !== undefined) {
      return output > before
        ? { model, scope, input: 0, output: output - before, cacheRead: 0, cacheWrite: 0 }
        : null;
    }
    return {
      model,
      scope,
      input: count(usage.input_tokens),
      output,
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
    };
  }

  /** The usage of whole JSONL lines, added up per model and scope; malformed lines are skipped. */
  addLines(lines: Iterable<string>, scope: (entry: unknown) => TokenUsageScope): TokenUsage[] {
    const rows: TokenUsage[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const row = this.add(entry, scope(entry));
      if (row) rows.push(row);
    }
    return mergeTokenUsage(rows);
  }
}

function count(value: unknown): number {
  const n = num(value);
  return n !== null && n > 0 ? Math.floor(n) : 0;
}
