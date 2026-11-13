/**
 * The stable codes of the server's errors: `ApiError.code` of a REST answer and the message
 * of a websocket `error` event. The web app shows a translated message for each; the server
 * raises no other code.
 */
export const ERROR_CODES = [
  'acceptance_item_not_found',
  'acceptance_item_refused',
  'administration_boot_mismatch',
  'administration_failed',
  'administration_operation_conflict',
  'administration_target_mismatch',
  // The protected administration adapter of the hub and of an engine (PM-763): no supervisor, or an engine
  // that does not offer it (503); the target or the command is not the one the supervisor serves (409); the
  // operation id is held by another command or another operation is running (409); the expected boot is
  // stale (409); the operation failed on the machine.
  'administration_unavailable',
  'ai_approval_forbidden',
  'ai_disabled',
  'ai_limit_reached',
  'already_member',
  'already_set_up',
  'answer_required',
  'approval_requested',
  'approver_unavailable',
  // The AI member's named assignee exceeds the card's complexity limit or misses its specialty
  // (`team.assigneeFit`, PM-1136); details: member, reason, points, limit.
  'assignee_unfit',
  'attachment_storage_failed',
  'attachment_too_large',
  'bad_request',
  'board_column_chronological',
  // A board move (PM-118): the card or the anchor is not where the request saw it (409); the column
  // is ordered by closing time, or does not exist (400/409).
  'board_stale',
  'builtin_role',
  'cannot_remove_self',
  'card_busy',
  'checklist_condition_unmet',
  'checklist_exists',
  'checklist_full',
  'checklist_item_not_found',
  'checklist_missing',
  'codex_setup_incomplete',
  'collecting_task_not_startable',
  // The app project manager must hand machine and unsupported commands to the integrator (403).
  'command_not_for_project_manager',
  'comment_attachment_limit',
  'comment_attachment_unavailable',
  // A comment edit based on an older version (PM-1277): 409, `{ currentRevision }`
  'comment_edit_conflict',
  'comment_required',
  'complexity_forbidden',
  'complexity_limit_not_developer',
  'complexity_points_invalid',
  'compute_job_busy',
  'compute_job_commit_unpublished',
  // The team tool `run_compute_job` (PM-1148): the repository has no such job, two jobs run already, the commit
  // is not on the repository's GitHub default branch.
  'compute_job_unknown',
  'config_conflict',
  'config_invalid',
  'config_version_outdated',
  // A cover must be a ready image of the card (PM-224)
  'cover_not_an_image',
  'custom_role_shadows_builtin',
  // Too little free disk space (PM-243): no new session starts until there is room again.
  'disk_low',
  'docs_edit_ambiguous',
  'docs_edit_not_found',
  'docs_not_append_only',
  // The project manager's documents (PM-495): not set up; an edit that does not apply (422); a log line that would
  // change; no change at all; the file moved on since it was read; a write already waits or runs (409);
  // the write did not go up (409).
  'docs_not_configured',
  'docs_stale',
  'docs_unchanged',
  'docs_write_failed',
  'docs_write_pending',
  'document_conflict',
  // Every document write needs its one-line reason (PM-1215): missing or blank (400)
  'document_message_required',
  // The project's documents (PM-147): unknown (404), changed meanwhile (409, `{ currentVersion }`), too large (413, `{ limitBytes }`)
  'document_not_found',
  'document_too_large',
  // Two feedback surfaces with the same id or address.
  'duplicate_feedback_surface',
  'duplicate_not_allowed',
  'duplicate_repo',
  'duplicate_role',
  'email_channel_off',
  'email_code_invalid',
  'email_contact_refused',
  'email_content_refused',
  'email_login_name_required',
  'email_login_no_access',
  'email_login_rate_limited',
  'email_login_unavailable',
  'email_mailbox_taken',
  'email_not_configured',
  'email_rate_limited',
  'email_recipient_refused',
  'email_send_failed',
  'email_sender_not_enabled',
  'email_unknown',
  'engine_in_use',
  'engine_is_default',
  // Isolation on the hub (PM-1061): a call for a project the engine is not bound to (409), a machine or
  // administration call for an engine that is not the host's (409), the host's NanoGPT key asked for or
  // started on an engine of another owner (409), an operation of the host owner's key only (403).
  'engine_not_bound',
  'engine_not_found',
  'engine_not_host',
  // Project–engine binding (PM-1060): not the engine's owner, a session still on it, the project's base engine.
  'engine_not_owned',
  // The session's engine is not connected (PM-311): the start waits for it.
  'engine_offline',
  'engine_revoked',
  'event_cursor_expired',
  'feedback_closed',
  'feedback_code_invalid',
  'feedback_mark_not_found',
  'feedback_not_allowed',
  'feedback_not_closed',
  // Feedback marks (PM-506): the project has no surface set up (409); the surface or the mark is unknown
  // (404); the member may not mark (403, the reason in `details.reason`); only a processor decides (403); the
  // page is not on an allowed address (403); the launch code or the tool session is not valid (401); too
  // many marks or comments (429); the screenshot is not a real image (422) or too large (413); the page is
  // not on the session's surface (422); the mark is closed, not closed, has a card already, or waits for the
  // owner (409).
  'feedback_not_configured',
  'feedback_origin_not_allowed',
  'feedback_page_mismatch',
  'feedback_processor_only',
  'feedback_rate_limited',
  'feedback_screenshot_invalid',
  'feedback_screenshot_too_large',
  'feedback_session_invalid',
  'feedback_surface_not_found',
  'feedback_task_exists',
  'feedback_waiting_owner',
  // Passing a held card to the people needs the lead's judgement, and its recommendation an executable outcome (PM-714).
  'fix_limit_assessment_required',
  'fix_limit_invalid_recommendation',
  'fix_limit_no_planner',
  'fix_limit_not_decider',
  // The fix round limit (PM-262): the card is not held, the caller does not decide it, nobody can plan.
  'fix_limit_not_held',
  // The server's full test of the pinned commit (PM-217) has not ended: the review start waits for it.
  'full_test_pending',
  'gate_blocked',
  // A super-mode card update left the requested stage or assignee unchanged (PM-929).
  'hand_on_requested',
  'handle_taken',
  'handoff_not_open',
  // The repository's hand-over check has no green result on the handed-over commit (PM-1380)
  'handover_check_missing',
  // The handed-over work has uncommitted changes (PM-183)
  'handover_uncommitted',
  // The document copy changed since the search that named the commit; search again (409).
  'history_source_changed',
  // The private search statistics are not for this caller or this request (403, PM-787).
  'history_stats_forbidden',
  // The search index cannot be used now (503).
  'history_unavailable',
  'host_only',
  'host_request_closed',
  'host_request_limit',
  // A request to the host (PM-1064): the project's owners include the host (409), five are open already (409),
  // or it was answered or withdrawn already (409).
  'host_request_not_needed',
  'inbox_item_closed',
  // A standby copy of the installation (PM-143, `instance.json`): only the active instance starts AI work
  'instance_standby',
  'insufficient_access',
  'integrator_host_required',
  'integrator_https_required',
  'integrator_key_invalid',
  'integrator_not_allowed',
  'integrator_read_only',
  'internal_error',
  'invalid_command',
  'invalid_config',
  'invalid_credentials',
  'invalid_event_cursor',
  'invalid_json',
  'invalid_origin',
  'invalid_outcome_fields',
  'invalid_request',
  'invalid_sponsor',
  'invite_invalid',
  'invite_member_not_found',
  'invite_member_not_human',
  'invite_password_account_required',
  'invite_used',
  'issuer_without_machine_access',
  'label_not_allowed',
  'login_required',
  // The machine's memory is under critical pressure (PM-1278): no new session starts until it eases.
  'machine_busy',
  'member_at_capacity',
  'member_has_account',
  'member_invite_pending',
  // 403: an AI member tried to involve a member on a card, which the project settings do not allow it (PM-1267)
  'member_involvement_refused',
  'member_not_scheduled',
  'member_on_leave',
  // 409: a start while the member is being renamed
  'member_renaming',
  // 409; `details.reason`: session | workspace | queue | deferred_start (PM-1025)
  'member_session_live',
  'merge_fix_engine_mismatch',
  'merge_fix_invalid',
  'merge_fix_not_allowed',
  'merge_not_merger',
  'merge_not_prioritizable',
  'merge_not_ready',
  'merge_queue_conflict',
  'merger_unresolved',
  'message_attachment_limit',
  // A file of a team message (PM-515): not usable for this send (409, `{ id }`), or too many unsent (409, `{ max }`)
  'message_attachment_unavailable',
  'missing_duty_holder',
  'nanogpt_key_missing',
  'nanogpt_key_not_for_engine',
  'nanogpt_key_rejected',
  'nanogpt_setup_incomplete',
  'no_assignees',
  'no_free_member',
  'no_work_stage',
  'not_a_member',
  'not_a_recipient',
  'not_ai_member',
  'not_an_assignee',
  'not_an_outage_alert',
  'not_attached',
  'not_card_role',
  'not_found',
  'not_human_member',
  'not_stage_owner',
  'ntfy_not_configured',
  'ntfy_server_invalid',
  'ntfy_unavailable',
  'operator_agreement_pending',
  'operator_approval_stale',
  'operator_approval_used',
  'operator_grant_inactive',
  'operator_grant_owner_only',
  'operator_knowledge_invalid',
  'operator_knowledge_limit',
  'operator_knowledge_stale',
  'operator_knowledge_unavailable',
  'operator_message_recipient',
  'operator_never',
  'operator_no_request',
  'operator_only',
  'operator_owner_approval',
  // The project manager (PM-463): a message to it only from an owner's own login; a write without an open
  // request of the owner; a tool it never calls.
  'operator_owner_only',
  'operator_plan_required',
  'operator_preference_no_person',
  // The project manager's own steps on a system signal (PM-545): no more steps left, or too soon after the last;
  // a start_member on a card for a member with no role on it.
  'operator_signal_budget',
  'operator_signal_closed',
  'operator_signal_not_dismissible',
  // Owner accounts (PM-1062): the e-mail is the host owner's, or already has an active owner account (409).
  'owner_account_exists',
  'owner_approval_required',
  'owner_login_required',
  'owner_only',
  // An AI member's owner decision names no owner topic, or one the project does not list (PM-1190).
  'owner_topic_required',
  'owner_topic_unknown',
  'payload_too_large',
  // A place the project manager offers (PM-1071): a machine-level part, not the project's (403), or one the person does not see (403).
  'place_not_target',
  'place_not_visible',
  'plan_usage_paused',
  // A card whose prerequisite is not closed (PM-204): an automatic start waits, a person's start is
  // refused until the request says they start despite the warning.
  'prerequisite_open',
  'previous_run_live',
  'priority_humans_only',
  'project_exists',
  // 403: the PM took a lifecycle action the project settings do not list (PM-1098)
  'project_manager_lifecycle_refused',
  'project_manager_move_refused',
  'project_manager_only',
  'project_manager_required',
  'provider_not_logged_in',
  'provider_rate_limited',
  'provider_unsupported',
  'question_group_incompatible',
  // The project manager may not answer this queue item as a member's question (PM-1009).
  'question_not_answerable',
  'question_not_screening',
  'queue_item_not_processing',
  // A connected Claude's step on a queue item (decision 66): the item is not open for the key's holder (403),
  // or its issuer has no machine access (409).
  'queue_item_not_yours',
  'reask_not_allowed',
  /** A contact-restricted member wrote to someone who is not a project contact (PM-985); `details.recipients`. */
  'recipient_not_contact',
  'relation_cycle',
  'relation_duplicate_of_duplicate',
  'relation_not_found',
  'relation_parent_exists',
  'relation_self',
  'relation_target_not_found',
  'relation_target_project',
  'relation_theme',
  'release_already_published',
  'release_artifact_changed',
  'release_commit_unknown',
  // The hybrid release's durable deployment (PM-752): another attempt or a different request holds the
  // slot, the target or the engine is not the configured one, a foreign pause is open, the work is not
  // drained, the deployment waits for a person's recovery, the protocol is not available for this
  // instance, the artifact differs from the bound one.
  'release_deployment_conflict',
  'release_empty',
  'release_engine_mismatch',
  'release_four_eyes',
  // The team tool `publish_release` (PM-968): the repository has no GitHub repository, the commit has its
  // release already, the tag points at another commit, or the tag or the GitHub release could not be made.
  'release_no_github',
  // The release of the instance (PM-491): not set up for this project, one is open already, nothing new
  // to release, the commit is no recorded merge, the release is not in the state the step needs.
  'release_not_configured',
  'release_not_drained',
  'release_open',
  // A production release step (a dedicated-workflow compute job, a publication) is the owner's or the owner's
  // connected Claude's alone (PM-1238, decision 68): any AI member, the devops included, is refused.
  'release_owner_only',
  'release_pause_conflict',
  'release_protocol_unavailable',
  'release_publish_failed',
  'release_recovery_required',
  'release_state_conflict',
  'release_tag_taken',
  'release_target_mismatch',
  // A reply (PM-1290) must answer a comment of the same card.
  'reply_target_invalid',
  'repo_required',
  'role_id_mismatch',
  'role_in_use',
  'role_not_for_ai',
  'role_not_for_human',
  'self_review_forbidden',
  // A card recommended for the Senior while every Senior is busy (PM-348): only the automatic start
  // gets it, and waits; a person's Start is answered with the waiting card instead.
  'senior_busy',
  'server_stopping',
  'session_start_failed',
  'setup_code_invalid',
  'setup_requires_localhost',
  'specialty_labels_not_developer',
  'stage_in_use',
  // The member's automatic starts at a place failed (PM-1335): they back off, then stop until released.
  'start_backoff',
  'start_failing',
  'subtask_has_children',
  'subtask_parent_is_subtask',
  'subtask_parent_not_found',
  'subtask_parent_project',
  'subtask_self_parent',
  'subtask_theme',
  // No executor is registered for the command in this installation (503).
  'super_executor_unavailable',
  // Another client already executes the handoff (409).
  'super_handoff_busy',
  // The handoff or its operation is finished and cannot run again (409).
  'super_handoff_closed',
  // The owner did not answer in time (409).
  'super_operation_expired',
  // The configuration or the target changed since the handoff or the owner's answer (409).
  'super_operation_stale',
  // The operate operation is not executed in super mode yet (422, PM-831).
  'super_operation_unsupported',
  // The owner's question about the operation is still open (409).
  'super_owner_decision_pending',
  // The answer cannot be relayed for the owner (403).
  'super_relay_refused',
  // The same request id arrived with another command (409).
  'super_request_conflict',
  // The forwarding mode does not allow the action (409).
  'system_feedback_forwarding_mode',
  // The address is not an issue of the public projectman repository (400).
  'system_feedback_issue_url',
  // The project already recorded the most new items a day allows (409).
  'system_feedback_limit',
  // Only the project manager records system feedback (403).
  'system_feedback_operator_only',
  // The item is not in the state the action needs (409).
  'system_feedback_wrong_state',
  'task_closed',
  // The assignee handoff (PM-342): the card is being handed over to the member, whose start waits for it;
  // the caller is not the member the card is being handed over from.
  'task_handoff_open',
  'task_is_theme',
  'task_not_cancelled',
  // The card a feedback mark was to be linked to does not exist in the project.
  'task_not_found',
  'task_not_merged',
  'task_not_theme',
  'task_session_live',
  // The team is paused (PM-219): no work starts, and a message waits, until it is resumed.
  'team_paused',
  'theme_archived',
  'theme_closed',
  'theme_not_a_theme',
  'theme_not_found',
  'theme_on_subtask',
  'theme_on_theme',
  'theme_project',
  // The project manager screens AI members' questions (PM-558): a task the person cannot do needs a reason; the
  // question is not in screening; the outcome's fields do not fit; the question may not be asked again unscreened.
  'todo_reason_required',
  'too_many_attempts',
  'too_many_requests',
  'unauthorized',
  'unknown_column',
  'unknown_member',
  'unknown_option',
  'unknown_repo',
  'unknown_role',
  'unknown_stage',
  'unknown_template',
  'unknown_version',
  'unsupported_media_type',
  'update_not_applied',
  'web_push_device_limit',
  'web_push_endpoint_invalid',
  'web_push_endpoint_taken',
  'web_push_integrator_refused',
  'web_push_quiet_hours_invalid',
  'web_push_test_too_soon',
  'web_push_unavailable',
  // The work queues (PM-1294): the viewer's access reads none of them, or not this one.
  'work_queues_forbidden',
  'workspace_branch_missing',
  'workspace_busy',
  'workspace_codex_config',
  'workspace_dependencies_failed',
  'workspace_dependencies_pending',
  'workspace_dirty',
  'workspace_fetch_failed',
  'workspace_not_found',
  'workspace_source_missing',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const KNOWN = new Set<string>(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN.has(value);
}
