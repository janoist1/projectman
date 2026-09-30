import type { ConfigIssue } from '@projectman/shared';
import { t, tDynamic } from '../i18n/t';
import type { PlainMessageKey } from '../i18n/t';
import { codeMessage } from './errors';

/** A configuration issue as the server reports it: an invariant or a schema (zod) issue. */
export interface IssueRef {
  code: string;
  path: string;
}

/**
 * The message of every configuration invariant. Typed against the shared union, so a code
 * added to (or removed from) `ConfigIssue` fails the typecheck until it is translated here.
 */
export const CONFIG_ISSUE_MESSAGES: Record<ConfigIssue['code'], PlainMessageKey> = {
  missing_duty_holder: 'errors.codes.missing_duty_holder',
  recommended_duty_unfilled: 'errors.codes.recommended_duty_unfilled',
  duplicate_handle: 'settings.issues.duplicate_handle',
  no_owner: 'settings.issues.no_owner',
  unknown_member: 'errors.codes.unknown_member',
  unknown_label: 'settings.issues.unknown_label',
  duplicate_label: 'settings.issues.duplicate_label',
  missing_label_setter: 'settings.issues.missing_label_setter',
  release_without_human_approval: 'settings.issues.release_without_human_approval',
  release_approval_needs_duty: 'settings.issues.release_approval_needs_duty',
  unknown_column: 'settings.issues.unknown_column',
  duplicate_column: 'settings.issues.duplicate_column',
  first_stage_not_queue: 'settings.issues.first_stage_not_queue',
  last_stage_not_done: 'settings.issues.last_stage_not_done',
  duplicate_stage: 'settings.issues.duplicate_stage',
  duplicate_repo: 'errors.codes.duplicate_repo',
  sponsor_not_human: 'settings.issues.sponsor_not_human',
  codex_bypass_not_allowed: 'settings.issues.codex_bypass_not_allowed',
  unknown_role: 'errors.codes.unknown_role',
  role_not_for_ai: 'errors.codes.role_not_for_ai',
  role_not_for_human: 'errors.codes.role_not_for_human',
  custom_role_shadows_builtin: 'errors.codes.custom_role_shadows_builtin',
  duplicate_role: 'errors.codes.duplicate_role',
};

function isInvariantCode(code: string): code is ConfigIssue['code'] {
  return Object.prototype.hasOwnProperty.call(CONFIG_ISSUE_MESSAGES, code);
}

/** Readable text of an issue: invariants by their code, schema issues by the zod issue code. */
export function issueMessage(issue: IssueRef): string {
  if (isInvariantCode(issue.code)) return t(CONFIG_ISSUE_MESSAGES[issue.code]);
  return (
    codeMessage(issue.code) ?? tDynamic(`settings.issues.${issue.code}`, t('settings.issues.invalid_value'))
  );
}
