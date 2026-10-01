import { cheapSubagentOf, type AiMemberConfig, type CheapSubagentModel } from '@projectman/shared';
import type { SubagentDefinition } from '../contracts';
import { code } from './format';

/**
 * The cheap subagent (PM-179): a reader on a cheaper model that the member hands text-heavy,
 * logic-light work to, so that the member reads its short result instead of the raw text.
 *
 * Its name carries its model, so the session's activity and chat show the model from the call
 * alone, also when an old transcript is read again after the setting changed. It has no
 * `permissionMode`, `mcpServers` or `hooks` of its own: a subagent's own mode would apply under a
 * member in `default` or `plan` mode and could grant more than the member has. Its tool calls go
 * through the session's rules, sandbox and hooks; it has no edit tools, no team tools and cannot
 * start subagents.
 */
export const CHEAP_SUBAGENT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'] as const;

const MODEL_NAMES: Record<CheapSubagentModel, string> = { sonnet: 'Sonnet', haiku: 'Haiku' };

export function cheapSubagentName(model: CheapSubagentModel): string {
  return `reader-${model}`;
}

/** The cheap subagent of the member, when its provider supports one and it is switched on. */
export function cheapSubagent(member: AiMemberConfig): SubagentDefinition | null {
  const model = cheapSubagentOf(member);
  if (!model) return null;
  return {
    name: cheapSubagentName(model),
    description: `A reader on the cheaper ${MODEL_NAMES[model]} model for text-heavy, logic-light work: reading long logs and test output, searching across many files, summarizing, carrying text over. It returns a short result, not raw output. Not for decisions, writing code, or review and security judgements.`,
    prompt: [
      'You are a reader working for a member of an AI team. You do text-heavy, logic-light work for it: you read long logs and test output, search across many files, summarize and carry text over, so that it reads your short result instead of the raw text.',
      '- Return only a short, precise result: the facts asked for, with file paths and line numbers where they help. Never return raw output, whole files or long excerpts; quote only the few lines that matter.',
      '- Do not change the work: no file edits, commits or installs. Running a check or a test to read its output is fine.',
      '- Do not decide or judge: when the task asks for a decision, a review or a security verdict, report the facts and leave the judgement to the member.',
      '- If you cannot find something, say so plainly instead of guessing.',
    ].join('\n'),
    tools: [...CHEAP_SUBAGENT_TOOLS],
    model,
  };
}

/** The system prompt's rule for the cheap subagent; empty when the member has none. */
export function cheapSubagentSection(member: AiMemberConfig): string {
  const model = cheapSubagentOf(member);
  if (!model) return '';
  const name = cheapSubagentName(model);
  return [
    '# Cheap subagent',
    `You have a subagent on the cheaper ${MODEL_NAMES[model]} model: start it with the Agent tool, subagent_type ${code(name)}. Hand it text-heavy, logic-light work, so that you read its short result instead of the raw text:`,
    '- going through long logs and test output;',
    '- searching across many files;',
    '- summarizing, and carrying text over from one place to another.',
    'Do not hand it decisions, writing code, or review and security judgements: those stay with you.',
    'Tell it exactly what to find and ask for a short result, not raw output. It works within your permissions, with fewer tools: it reads and runs commands, but does not edit files or use the team tools.',
  ].join('\n');
}
