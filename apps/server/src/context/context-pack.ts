import type { ContextPack, ContextPackBuilder, ContextPackInput } from '../contracts';
import { buildBrief } from './brief';
import { buildSystemPrompt } from './system-prompt';
import { assess } from './work-item';

/**
 * Builds what an AI member knows when a Claude Code session starts. Deterministic: the
 * same input always gives the same text (no clock, no randomness).
 *
 * - `appendSystemPrompt` (for `--append-system-prompt`): identity, team roster, how the team
 *   works and the team tools, the pipeline, the current work item and what "done" means for
 *   the member there, guardrails, role instructions and the most recent ~8 KB of memory.
 *   The system prompt is not stored in the transcript, so pass a freshly built one on
 *   every start, including `--resume` (it then reflects the task's current stage).
 * - `initialMessage`: the kick-off brief for tasks or the scheduled prompt; null for general chats and
 *   meetings. The caller types it only into a NEW session: when resuming a session the
 *   brief is already in the conversation, so the caller ignores it and types the message
 *   that caused the resume instead.
 *
 * The project's own CLAUDE.md is not included: Claude Code loads it from the working
 * directory.
 */
export function createContextPackBuilder(): ContextPackBuilder {
  return {
    build(input: ContextPackInput): ContextPack {
      const situation = assess(input);
      return {
        appendSystemPrompt: buildSystemPrompt(input, situation),
        initialMessage: buildBrief(input, situation),
      };
    },
  };
}
