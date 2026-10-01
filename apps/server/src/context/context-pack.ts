import type { ContextPack, ContextPackBuilder, ContextPackInput } from '../contracts';
import { buildBrief } from './brief';
import { buildContinueMessage } from './continue-message';
import { cheapSubagent } from './subagents';
import { buildSystemPrompt } from './system-prompt';
import { assess } from './work-item';

/**
 * Builds what an AI member knows when a session starts (Claude Code or Codex). Deterministic:
 * the same input always gives the same text (no clock, no randomness).
 *
 * - `appendSystemPrompt` (Claude Code: `--append-system-prompt`; Codex:
 *   `developer_instructions`): identity, team roster, how the team works (the team rules,
 *   stated only here), the pipeline and labels, the current work item and what "done" means
 *   for the member there, guardrails, role instructions and the most recent ~8 KB of memory.
 *   The system prompt is not stored in the transcript, so pass a freshly built one on
 *   every start, including a resume (it then reflects the task's current stage).
 * - `initialMessage`: the kick-off brief for tasks or the scheduled prompt; null for general chats and
 *   meetings. The caller types it only into a NEW session: when resuming a session the
 *   brief is already in the conversation, so the caller ignores it and types the message
 *   that caused the resume instead. It refers to the steps in the system prompt rather than
 *   repeating them.
 * - `continueMessage`: what a resumed task session gets when no message caused the resume (it
 *   was restarted; the task, its stage and to check where it left off); null for other work
 *   items. The caller types it, in place of the brief, unless a message caused the resume.
 * - `subagents`: the member's cheap subagent when it has one (PM-179); the system prompt then has
 *   the rule for using it.
 *
 * The project's own rules file is not included: Claude Code loads CLAUDE.md from the working
 * directory, Codex AGENTS.md (else CLAUDE.md).
 */
export function createContextPackBuilder(): ContextPackBuilder {
  return {
    build(input: ContextPackInput): ContextPack {
      const situation = assess(input);
      return {
        appendSystemPrompt: buildSystemPrompt(input, situation),
        initialMessage: buildBrief(input, situation),
        continueMessage: buildContinueMessage(input, situation),
        subagents: [cheapSubagent(input.member)].filter((agent) => agent !== null),
      };
    },
  };
}
