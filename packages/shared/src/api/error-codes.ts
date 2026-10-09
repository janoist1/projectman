/**
 * The stable codes of the server's errors: `ApiError.code` of a REST answer and the message
 * of a websocket `error` event. The web app shows a translated message for each; the server
 * raises no other code.
 */
export const ERROR_CODES = [
  'integrator_key_invalid',
  'integrator_https_required',
  'integrator_not_allowed',
  'owner_approval_required',
  'owner_login_required',
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
  'setup_code_invalid',
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
  'approver_unavailable',
  'cannot_remove_self',
  'unknown_role',
  'role_not_for_ai',
  'role_not_for_human',
  'custom_role_shadows_builtin',
  'duplicate_role',
  'role_in_use',
  'project_manager_required',
  'project_manager_move_refused',
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
  // A board move (PM-118): the card or the anchor is not where the request saw it (409); the column
  // is ordered by closing time, or does not exist (400/409).
  'board_stale',
  'board_column_chronological',
  'unknown_column',
  'task_not_cancelled',
  'task_session_live',
  'priority_humans_only',
  'subtask_self_parent',
  'subtask_parent_not_found',
  'subtask_parent_project',
  'subtask_parent_is_subtask',
  'subtask_has_children',
  // Relations between cards (PM-192)
  'relation_self',
  'relation_target_not_found',
  'relation_target_project',
  'relation_cycle',
  'relation_duplicate_of_duplicate',
  'relation_not_found',
  'relation_parent_exists',
  'duplicate_not_allowed',
  // Themes (PM-192)
  'subtask_theme',
  'relation_theme',
  'task_is_theme',
  'task_not_theme',
  'theme_on_theme',
  'theme_on_subtask',
  'theme_not_found',
  'theme_project',
  'theme_not_a_theme',
  'theme_closed',
  'gate_blocked',
  'approval_requested',
  'label_not_allowed',
  'comment_required',
  // The recommended developer of a card (PM-347)
  'developer_level_forbidden',
  'developer_level_reason_required',
  'senior_not_allowed',
  'self_review_forbidden',
  'release_four_eyes',
  // The handed-over work has uncommitted changes (PM-183)
  'handover_uncommitted',
  // Attachments
  'attachment_too_large',
  'attachment_storage_failed',
  // A cover must be a ready image of the card (PM-224)
  'cover_not_an_image',
  // Inbox and messages
  'inbox_item_closed',
  'not_an_assignee',
  'no_assignees',
  'unknown_option',
  'answer_required',
  'ai_approval_forbidden',
  'not_a_recipient',
  // AI work: admission, task starts, schedules and sessions
  'engine_not_found',
  'engine_revoked',
  'ai_disabled',
  'ai_limit_reached',
  'plan_usage_paused',
  'provider_rate_limited',
  // The team is paused (PM-219): no work starts, and a message waits, until it is resumed.
  'team_paused',
  // Too little free disk space (PM-243): no new session starts until there is room again.
  'disk_low',
  'member_at_capacity',
  'member_on_leave',
  'previous_run_live',
  'repo_required',
  // A card whose prerequisite is not closed (PM-204): an automatic start waits, a person's start is
  // refused until the request says they start despite the warning.
  'prerequisite_open',
  'no_free_member',
  // A card recommended for the Senior while every Senior is busy (PM-348): only the automatic start
  // gets it, and waits; a person's Start is answered with the waiting card instead.
  'senior_busy',
  'no_work_stage',
  'not_stage_owner',
  'member_not_scheduled',
  'provider_not_logged_in',
  'nanogpt_key_missing',
  'nanogpt_setup_incomplete',
  'codex_setup_incomplete',
  'workspace_codex_config',
  'provider_unsupported',
  'nanogpt_key_rejected',
  'session_start_failed',
  // The question-free managed VM profile (PM-141): its boundary is not verified, or a CLI does not fit
  'managed_vm_unavailable',
  // A standby copy of the installation (PM-143, `instance.json`): only the active instance starts AI work
  'instance_standby',
  // Member workspaces (PM-138)
  'workspace_busy',
  'workspace_dirty',
  'workspace_fetch_failed',
  'workspace_branch_missing',
  'workspace_source_missing',
  // The VM boundary (PM-140): its readiness or a part of it failed, so no session starts.
  'runtime_boundary_not_ready',
  // The fix round limit (PM-262): the card is not held, the caller does not decide it, nobody can plan.
  'fix_limit_not_held',
  'fix_limit_not_decider',
  'fix_limit_no_planner',
  // The server's full test of the pinned commit (PM-217) has not ended: the review start waits for it.
  'full_test_pending',
  // The session's engine is not connected (PM-311): the start waits for it.
  'engine_offline',
  // The assignee handoff (PM-342): the card is being handed over to the member, whose start waits for it;
  // the caller is not the member the card is being handed over from.
  'task_handoff_open',
  'handoff_not_open',
  // The project's focus (PM-427): only a person who owns the project or prioritizes sets it; the item is
  // already in it, is not in it, the list is full, or the theme or card is closed.
  'focus_humans_only',
  'focus_not_allowed',
  'focus_item_exists',
  'focus_item_unknown',
  'focus_full',
  'focus_task_closed',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const KNOWN = new Set<string>(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN.has(value);
}
