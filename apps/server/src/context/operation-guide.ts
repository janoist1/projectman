import { OperatorOperation, NewSuperCommand } from '@projectman/shared';
import { z } from 'zod';

/** Noise the model does not need: the dialect URL and the "no other keys" flag of every object. */
const NOISE = new Set(['$schema', 'additionalProperties']);

function render(title: string, key: string, options: readonly z.ZodObject[]): string {
  return [
    `## ${title}`,
    ...options.map((option) => {
      const tag = (option.shape[key] as z.ZodLiteral<string>).value;
      const json = z.toJSONSchema(option, { io: 'input', unrepresentable: 'any' });
      return `- ${key}=${tag}: ${JSON.stringify(json, (name, value: unknown) => (NOISE.has(name) ? undefined : value))}`;
    }),
  ].join('\n');
}

/** The rules of `operate` and `execute_operation` that their tool descriptions point to (PM-1114). */
const OPERATION_RULES = [
  '## Rules',
  '- operate runs immediate changes, asks the owner to approve restricted ones and refuses forbidden ones.',
  '- Before changing a built-in role, read get_role_configuration, keep its existing instructions and other bundle fields, and send only the affected role in config_patch.roleOverrides. Each supplied bundle replaces that role completely; omitted roles stay unchanged; null resets only that role to the built-in defaults; an empty map changes no roles.',
  '- To add or change one pipeline label (name, color, meaning), send only that label in config_patch.labels, keyed by its id, e.g. {"bug": {"color": "red"}}. Omitted fields and all other labels, stages and columns stay unchanged; null removes the color or the meaning.',
  '- session_stop and message_send need plan (why, impact, reversible). message_send is for non-owner humans, with the exact text the owner approves.',
  '- The project manager may run task_create, task_update, task_labels, task_start, task_cancel, member_update, merge_order and operate with execute_operation. Every other kind is refused with command_not_for_project_manager: with machine access open an integrator todo (open_integrator_todo), otherwise ask the owners with ask_human. For the Operator, operate and member_update are refused there with super_operation_unsupported: use the operate tool.',
  "- workspace_release, inbox_resolve, merge, merge_order and invite_create run only when the open request is an owner's own message or answer; for a queue item or another member's message they are refused with operator_owner_only: ask the owners with ask_human.",
  "- workspace_release frees the workspace an unresolved process cleanup keeps reserved without proof that the processes stopped: only on the owner's explicit request in that conversation, never on a signal by itself; reason is the owner's stated reason.",
  "- On a member's request task_labels runs with your own label rights: approval and human-only labels are refused.",
  "- A K3 effect (deletion, security, cost and permission decisions) does not run at once: the operation waits in waiting_owner, the owner answers with their own login, and after the owner's yes the server runs it by itself, so do not repeat the call.",
  "- Machine operations go through the integrator on the owner's request.",
].join('\n');

/**
 * The `operations` guide of the Operator: the fields of every `operate` operation and every
 * `execute_operation` command, generated from the schemas the server validates with, so the
 * rule lives in one place (PM-1034), and the rules of both tools.
 */
export function operationsGuide(): string {
  return [
    '# Operations guide',
    'The tool inputs name only the kind (`operation.op`, `command.kind`); the server validates the rest against the schemas below (JSON Schema of the input) and refuses with the path of the faulty field.',
    OPERATION_RULES,
    render('operate: operation', 'op', OperatorOperation.options),
    render('execute_operation: command', 'kind', NewSuperCommand.options),
  ].join('\n\n');
}
