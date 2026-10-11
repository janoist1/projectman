/**
 * The stable codes of the server's errors: `ApiError.code` of a REST answer and the message
 * of a websocket `error` event. The web app shows a translated message for each; the server
 * raises no other code.
 */
export const ERROR_CODES = [
  'operator_signal_closed',
  'merge_not_merger',
  'merge_not_ready',
  'merge_fix_not_allowed',
  'merge_fix_invalid',
  'merge_fix_engine_mismatch',
  'task_not_merged',
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
  'merger_unresolved',
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
  'operator_required',
  'operator_fixed',
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
  'not_an_outage_alert',
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
  // The Operator (PM-463): a message to it only from an owner's own login; a write without an open
  // request of the owner; a tool it never calls.
  'operator_owner_only',
  'operator_no_request',
  'operator_never',
  'operator_only',
  'operator_approval_stale',
  // The Operator's documents (PM-495): not set up; an edit that does not apply (422); a log line that would
  // change; no change at all; the file moved on since it was read; a write already waits or runs (409);
  // the write did not go up (409).
  'docs_not_configured',
  'docs_edit_not_found',
  'docs_edit_ambiguous',
  'docs_not_append_only',
  'docs_unchanged',
  'docs_stale',
  'docs_write_pending',
  'docs_write_failed',
  // The release of the instance (PM-491): not set up for this project, one is open already, nothing new
  // to release, the commit is no recorded merge, the release is not in the state the step needs.
  'release_not_configured',
  'release_open',
  'release_empty',
  'release_commit_unknown',
  'release_state_conflict',
  // Feedback marks (PM-506): the project has no surface set up (409); the surface or the mark is unknown
  // (404); the member may not mark (403, the reason in `details.reason`); only a processor decides (403); the
  // page is not on an allowed address (403); the launch code or the tool session is not valid (401); too
  // many marks or comments (429); the screenshot is not a real image (422) or too large (413); the page is
  // not on the session's surface (422); the mark is closed, not closed, has a card already, or waits for the
  // owner (409).
  'feedback_not_configured',
  'feedback_surface_not_found',
  'feedback_mark_not_found',
  'feedback_not_allowed',
  'feedback_processor_only',
  'feedback_origin_not_allowed',
  'feedback_code_invalid',
  'feedback_session_invalid',
  'feedback_rate_limited',
  'feedback_screenshot_invalid',
  'feedback_screenshot_too_large',
  'feedback_page_mismatch',
  'feedback_closed',
  'feedback_not_closed',
  'feedback_task_exists',
  'feedback_waiting_owner',
  // The card a feedback mark was to be linked to does not exist in the project.
  'task_not_found',
  // Two feedback surfaces with the same id or address.
  'duplicate_feedback_surface',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const KNOWN = new Set<string>(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN.has(value);
}
