/**
 * The stable codes of the server's errors: `ApiError.code` of a REST answer and the message
 * of a websocket `error` event. The web app shows a translated message for each; the server
 * raises no other code.
 */
export const ERROR_CODES = [
  'checklist_missing',
  'checklist_item_not_found',
  'checklist_condition_unmet',
  'checklist_full',
  'checklist_exists',
  'email_not_configured',
  'email_channel_off',
  'email_sender_not_enabled',
  'email_recipient_refused',
  'email_content_refused',
  'email_rate_limited',
  'email_contact_refused',
  'email_unknown',
  'email_send_failed',
  'email_mailbox_taken',
  'web_push_unavailable',
  'web_push_endpoint_invalid',
  'web_push_device_limit',
  'web_push_endpoint_taken',
  'web_push_quiet_hours_invalid',
  'web_push_integrator_refused',
  'web_push_test_too_soon',
  'operator_knowledge_invalid',
  'operator_knowledge_unavailable',
  'operator_knowledge_stale',
  'operator_knowledge_limit',
  'card_busy',
  'operator_signal_closed',
  'operator_signal_not_dismissible',
  'merge_not_merger',
  'merge_not_ready',
  'merge_not_prioritizable',
  'merge_fix_not_allowed',
  'merge_fix_invalid',
  'merge_fix_engine_mismatch',
  'task_not_merged',
  'integrator_key_invalid',
  'integrator_host_required',
  'integrator_https_required',
  'invalid_event_cursor',
  'event_cursor_expired',
  'integrator_not_allowed',
  'operator_grant_owner_only',
  'operator_grant_inactive',
  'owner_approval_required',
  'integrator_read_only',
  'merge_queue_conflict',
  'owner_login_required',
  'queue_item_not_processing',
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
  /** A contact-restricted member wrote to someone who is not a project contact (PM-985); `details.recipients`. */
  'recipient_not_contact',
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
  // 409; `details.reason`: session | workspace | queue | deferred_start (PM-1025)
  'member_session_live',
  // 409: a start while the member is being renamed
  'member_renaming',
  'project_manager_move_refused',
  // 403: the PM took a lifecycle action the project settings do not list (PM-1098)
  'project_manager_lifecycle_refused',
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
  // E-mail login of invited clients (PM-670)
  'email_login_unavailable',
  'email_login_rate_limited',
  'email_code_invalid',
  'email_login_name_required',
  'email_login_no_access',
  'invite_password_account_required',
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
  // A super-mode card update left the requested stage or assignee unchanged (PM-929).
  'hand_on_requested',
  'update_not_applied',
  'label_not_allowed',
  'comment_required',
  'complexity_forbidden',
  'complexity_points_invalid',
  'complexity_limit_not_developer',
  'specialty_labels_not_developer',
  'self_review_forbidden',
  'release_four_eyes',
  // The handed-over work has uncommitted changes (PM-183)
  'handover_uncommitted',
  // Attachments
  'attachment_too_large',
  'attachment_storage_failed',
  // A file of a team message (PM-515): not usable for this send (409, `{ id }`), or too many unsent (409, `{ max }`)
  'message_attachment_unavailable',
  'message_attachment_limit',
  // A cover must be a ready image of the card (PM-224)
  'cover_not_an_image',
  // Inbox and messages
  'inbox_item_closed',
  'not_an_outage_alert',
  'not_an_assignee',
  'no_assignees',
  'unknown_option',
  'answer_required',
  // The Operator screens AI members' questions (PM-558): a task the person cannot do needs a reason; the
  // question is not in screening; the outcome's fields do not fit; the question may not be asked again unscreened.
  'todo_reason_required',
  'question_not_screening',
  // The Operator may not answer this queue item as a member's question (PM-1009).
  'question_not_answerable',
  'question_group_incompatible',
  'invalid_outcome_fields',
  'reask_not_allowed',
  'ai_approval_forbidden',
  'not_a_recipient',
  // AI work: admission, task starts, schedules and sessions
  'engine_not_found',
  'engine_revoked',
  // Project–engine binding (PM-1060): not the engine's owner, a session still on it, the project's base engine.
  'engine_not_owned',
  // Owner accounts (PM-1062): the e-mail is the host owner's, or already has an active owner account (409).
  'owner_account_exists',
  'engine_in_use',
  'engine_is_default',
  // Isolation on the hub (PM-1061): a call for a project the engine is not bound to (409), a machine or
  // administration call for an engine that is not the host's (409), the host's NanoGPT key asked for or
  // started on an engine of another owner (409), an operation of the host owner's key only (403).
  'engine_not_bound',
  'engine_not_host',
  'nanogpt_key_not_for_engine',
  'host_only',
  // A request to the host (PM-1064): the project's owners include the host (409), five are open already (409),
  // or it was answered or withdrawn already (409).
  'host_request_not_needed',
  'host_request_limit',
  'host_request_closed',
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
  // The AI member's named assignee exceeds the card's complexity limit or misses its specialty
  // (`team.assigneeFit`, PM-1136); details: member, reason, points, limit.
  'assignee_unfit',
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
  // A standby copy of the installation (PM-143, `instance.json`): only the active instance starts AI work
  'instance_standby',
  // Member workspaces (PM-138)
  'workspace_busy',
  'workspace_dirty',
  'workspace_fetch_failed',
  'workspace_dependencies_pending',
  'workspace_dependencies_failed',
  'workspace_branch_missing',
  'workspace_source_missing',
  // The fix round limit (PM-262): the card is not held, the caller does not decide it, nobody can plan.
  'fix_limit_not_held',
  'fix_limit_not_decider',
  'fix_limit_no_planner',
  // Passing a held card to the people needs the lead's judgement, and its recommendation an executable outcome (PM-714).
  'fix_limit_assessment_required',
  'fix_limit_invalid_recommendation',
  // The server's full test of the pinned commit (PM-217) has not ended: the review start waits for it.
  'full_test_pending',
  // The session's engine is not connected (PM-311): the start waits for it.
  'engine_offline',
  // The assignee handoff (PM-342): the card is being handed over to the member, whose start waits for it;
  // the caller is not the member the card is being handed over from.
  'task_handoff_open',
  'handoff_not_open',
  // The Operator (PM-463): a message to it only from an owner's own login; a write without an open
  // request of the owner; a tool it never calls.
  'operator_owner_only',
  // A connected Claude's step on a queue item (decision 66): the item is not open for the key's holder (403),
  // or its issuer has no machine access (409).
  'queue_item_not_yours',
  'issuer_without_machine_access',
  'operator_no_request',
  'operator_never',
  'operator_only',
  // The app project manager must hand machine and unsupported commands to the integrator (403).
  'command_not_for_project_manager',
  'project_manager_only',
  'operator_preference_no_person',
  'operator_approval_stale',
  'operator_agreement_pending',
  'operator_plan_required',
  'operator_message_recipient',
  'operator_owner_approval',
  'operator_approval_used',
  // The Operator's own steps on a system signal (PM-545): no more steps left, or too soon after the last;
  // a start_member on a card for a member with no role on it.
  'operator_signal_budget',
  'not_card_role',
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
  // The team tool `publish_release` (PM-968): the repository has no GitHub repository, the commit has its
  // release already, the tag points at another commit, or the tag or the GitHub release could not be made.
  'release_no_github',
  'release_already_published',
  'release_tag_taken',
  'release_publish_failed',
  // The hybrid release's durable deployment (PM-752): another attempt or a different request holds the
  // slot, the target or the engine is not the configured one, a foreign pause is open, the work is not
  // drained, the deployment waits for a person's recovery, the protocol is not available for this
  // instance, the artifact differs from the bound one.
  'release_deployment_conflict',
  'release_target_mismatch',
  'release_pause_conflict',
  'release_not_drained',
  'release_recovery_required',
  'release_protocol_unavailable',
  'release_artifact_changed',
  'release_engine_mismatch',
  // The protected administration adapter of the hub and of an engine (PM-763): no supervisor, or an engine
  // that does not offer it (503); the target or the command is not the one the supervisor serves (409); the
  // operation id is held by another command or another operation is running (409); the expected boot is
  // stale (409); the operation failed on the machine.
  'administration_unavailable',
  'administration_target_mismatch',
  'administration_operation_conflict',
  'administration_boot_mismatch',
  'administration_failed',
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
  // Super mode durable handoff (PM-762).
  // The same request id arrived with another command (409).
  'super_request_conflict',
  // The configuration or the target changed since the handoff or the owner's answer (409).
  'super_operation_stale',
  // Another client already executes the handoff (409).
  'super_handoff_busy',
  // The handoff or its operation is finished and cannot run again (409).
  'super_handoff_closed',
  // The owner's question about the operation is still open (409).
  'super_owner_decision_pending',
  // The owner did not answer in time (409).
  'super_operation_expired',
  // No executor is registered for the command in this installation (503).
  'super_executor_unavailable',
  // The operate operation is not executed in super mode yet (422, PM-831).
  'super_operation_unsupported',
  // The answer cannot be relayed for the owner (403).
  'super_relay_refused',
  // History search (PM-786).
  // The search index cannot be used now (503).
  'history_unavailable',
  // The document copy changed since the search that named the commit; search again (409).
  'history_source_changed',
  // The private search statistics are not for this caller or this request (403, PM-787).
  'history_stats_forbidden',
  // System feedback (PM-472).
  // The item is not in the state the action needs (409).
  'system_feedback_wrong_state',
  // The forwarding mode does not allow the action (409).
  'system_feedback_forwarding_mode',
  // The project already recorded the most new items a day allows (409).
  'system_feedback_limit',
  // The address is not an issue of the public projectman repository (400).
  'system_feedback_issue_url',
  // Only the Operator records system feedback (403).
  'system_feedback_operator_only',
  // A place the project manager offers (PM-1071): a machine-level part, not the project's (403), or one the person does not see (403).
  'place_not_target',
  'place_not_visible',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const KNOWN = new Set<string>(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN.has(value);
}
