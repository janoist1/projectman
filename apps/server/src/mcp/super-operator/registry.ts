import type { ExternalCredentialMode } from '../../contracts';
import type { ExternalRegisteredTool, TeamToolName } from '../kit';
import { TEAM_TOOLS } from '../tools';
import { EXTERNAL_ONLY_TOOLS } from './tools';

/**
 * The tools of the bearer endpoint (PM-760): the shared tool definitions that declare an `external` binding,
 * then the tools only this endpoint has. A shared tool without a binding is denied (default deny): it is
 * neither listed nor callable, however its member counterpart is configured.
 */
export const EXTERNAL_TOOLS: readonly ExternalRegisteredTool[] = [
  ...TEAM_TOOLS.flatMap((tool) => (tool.external ? [tool.external] : [])),
  ...EXTERNAL_ONLY_TOOLS,
];

const SESSION = 'it works through a member session: its folders, working directory, open request or token';
const OPERATOR =
  'it is a tool of the Operator or of the project manager, bound to the owner request of their own conversation';
const DECISION =
  'it records a decision, approval or question of a member or an owner; the integrator never decides for them';
const FILES = 'it moves files between a session folder or working directory and the project';
const MEMBER_DUTY = 'it is a duty of an AI member of the card: its session, its hand-over or its merge duty';
const EMAIL =
  'it is a tool of an AI member who is allowed to send e-mail; the integrator is not an e-mail sender';
const HOST_REQUEST =
  "it is the project manager's tool inside its own project; the host reads and answers requests with list_host_inbox and answer_host_request";
const UNBOUND = 'it has no external binding yet';
const PRIVATE_STATS =
  "it reads the private search statistics, which only the Operator shows to an owner's or admin's own request";

/**
 * Why each shared tool is not served here. It only words the refusal; the denial itself is the missing binding.
 * A test checks that every shared tool is either bound or named here, and never both.
 */
export const EXTERNAL_DENIED: Partial<Record<TeamToolName, string>> = {
  get_checklist: OPERATOR,
  update_checklist: OPERATOR,
  get_operator_preference: OPERATOR,
  get_operator_knowledge: OPERATOR,
  propose_operator_knowledge: OPERATOR,
  set_operator_preference: OPERATOR,
  operate: OPERATOR,
  execute_operation: OPERATOR,
  get_operation: OPERATOR,
  get_machine_status: OPERATOR,
  get_machine_logs: OPERATOR,
  list_decision_candidates: OPERATOR,
  mark_decision_candidates: OPERATOR,
  list_system_feedback: OPERATOR,
  record_system_feedback: OPERATOR,
  get_history_search_stats: PRIVATE_STATS,
  screen_question: OPERATOR,
  combine_questions: OPERATOR,
  dismiss_signal: OPERATOR,
  open_integrator_todo: OPERATOR,
  triage_loop: OPERATOR,
  start_task: OPERATOR,
  start_member: OPERATOR,
  reassign_task: OPERATOR,
  cancel_task: OPERATOR,
  decide_permission_request: DECISION,
  decide_fix_limit: DECISION,
  hand_off: MEMBER_DUTY,
  merge_task: MEMBER_DUTY,
  prioritize_merge: MEMBER_DUTY,
  publish_release: MEMBER_DUTY,
  list_merge_checks: UNBOUND,
  link_pull_request: MEMBER_DUTY,
  save_memory: SESSION,
  set_current_work: SESSION,
  get_guide: SESSION,
  read_message_attachment: FILES,
  attach_file: FILES,
  delete_attachment: UNBOUND,
  take_screenshots: SESSION,
  get_screenshot_run: SESSION,
  get_feedback: UNBOUND,
  reply_feedback: UNBOUND,
  create_task_from_feedback: UNBOUND,
  link_feedback: UNBOUND,
  forward_feedback: UNBOUND,
  close_feedback: UNBOUND,
  send_email: EMAIL,
  set_email_contact: EMAIL,
  list_email_contacts: EMAIL,
  ask_host: HOST_REQUEST,
  list_host_requests: HOST_REQUEST,
  withdraw_host_request: HOST_REQUEST,
};

export function externalDenial(name: string): string {
  return EXTERNAL_DENIED[name as TeamToolName] ?? UNBOUND;
}

/** The bound tool with this name, or undefined: unbound and unknown tools are alike not served. */
export function externalToolNamed(name: string): ExternalRegisteredTool | undefined {
  return EXTERNAL_TOOLS.find((tool) => tool.name === name);
}

/** The tools a credential mode is offered, and may call; a `hostOnly` tool only when the key is the host owner's. */
export function externalToolsFor(mode: ExternalCredentialMode, host: boolean): ExternalRegisteredTool[] {
  return EXTERNAL_TOOLS.filter((tool) => tool.modes.includes(mode) && (host || !tool.hostOnly));
}
