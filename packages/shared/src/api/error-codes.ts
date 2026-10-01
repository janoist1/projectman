/**
 * The stable codes of the server's errors: `ApiError.code` of a REST answer and the message
 * of a websocket `error` event. The web app shows a translated message for each; the server
 * raises no other code.
 */
export const ERROR_CODES = [
  // Requests, login and access
  'bad_request',
  'invalid_json',
  'invalid_request',
  'invalid_origin',
  'payload_too_large',
  'unsupported_media_type',
  'too_many_requests',
  'not_found',
  'internal_error',
  'unauthorized',
  'invalid_credentials',
  'too_many_attempts',
  'setup_requires_localhost',
  'already_set_up',
  'not_a_member',
  'insufficient_access',
  'owner_only',
  'server_stopping',
  // Websocket
  'invalid_command',
  'not_attached',
  // Projects and configuration
  'project_exists',
  'workspace_not_found',
  'unknown_template',
  'unknown_version',
  'invalid_config',
  'config_invalid',
  'config_conflict',
  'duplicate_repo',
  'stage_in_use',
  'missing_duty_holder',
  // Members, roles and invitations
  'handle_taken',
  'unknown_member',
  'invalid_sponsor',
  'not_ai_member',
  'not_human_member',
  'cannot_remove_self',
  'unknown_role',
  'role_not_for_ai',
  'role_not_for_human',
  'custom_role_shadows_builtin',
  'duplicate_role',
  'role_in_use',
  'builtin_role',
  'role_id_mismatch',
  'already_member',
  'member_has_account',
  'member_invite_pending',
  'invite_member_not_found',
  'invite_member_not_human',
  'invite_invalid',
  'invite_used',
  'login_required',
  // Tasks, labels and gates
  'unknown_stage',
  'unknown_repo',
  'task_closed',
  'task_not_cancelled',
  'task_session_live',
  'subtask_self_parent',
  'subtask_parent_not_found',
  'subtask_parent_project',
  'subtask_parent_is_subtask',
  'subtask_has_children',
  'gate_blocked',
  'approval_requested',
  'label_not_allowed',
  'comment_required',
  'self_review_forbidden',
  'release_four_eyes',
  // Attachments
  'attachment_too_large',
  'attachment_storage_failed',
  // Inbox and messages
  'inbox_item_closed',
  'not_an_assignee',
  'no_assignees',
  'unknown_option',
  'answer_required',
  'ai_approval_forbidden',
  'not_a_recipient',
  // AI work: admission, task starts, schedules and sessions
  'ai_disabled',
  'ai_limit_reached',
  'plan_usage_paused',
  'member_at_capacity',
  'member_on_leave',
  'previous_run_live',
  'repo_required',
  'no_free_member',
  'no_work_stage',
  'not_stage_owner',
  'member_not_scheduled',
  'provider_not_logged_in',
  'session_start_failed',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const KNOWN = new Set<string>(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN.has(value);
}
