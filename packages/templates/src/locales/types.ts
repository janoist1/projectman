import type { BuiltInRoleId, DutyId, SystemFeedbackTextLabels } from '@projectman/shared';

/** Board column keys used by the factory templates (also used as column ids). */
export type ColumnKey =
  | 'ready'
  | 'development'
  | 'in_progress'
  | 'review'
  | 'client_test'
  | 'awaiting_merge'
  | 'awaiting_release'
  | 'done';

/** Stage keys used by the factory templates (also used as stage ids). */
export type StageKey =
  | 'ready'
  | 'dev'
  | 'work'
  | 'code_review'
  | 'integration'
  | 'qa'
  | 'client_test'
  | 'merge'
  | 'release'
  | 'done';

export type SpecialtyKey = 'frontend' | 'backend';

/** The base startup checklist items, then the items the templates add (PM-977). */
export type ChecklistItemKey =
  | 'goal'
  | 'code'
  | 'providers'
  | 'team'
  | 'process'
  | 'labels'
  | 'clients'
  | 'release'
  | 'agreement'
  | 'first_task'
  | 'code_review'
  | 'guests'
  | 'feedback_marks'
  | 'qa'
  | 'client_test'
  | 'deploy'
  | 'schedule';

/** Members a template hires under a display name of their own (not the role's name). */
export type TemplateMemberKey = 'daily_worker';

export interface WebPushText {
  title: Record<'question' | 'decision' | 'approval' | 'permission' | 'release', string>;
  digest: { title: string; body: string };
  test: { title: string; body: string };
}

/** Labels the templates may ship; rules live in ../labels.ts, words in the locales. */
export type StandardLabelId =
  | 'code-review-ok'
  | 'code-review-changes'
  | 'code-review-blocked'
  | 'security-ok'
  | 'security-changes'
  | 'qa-ok'
  | 'qa-failed'
  | 'qa-retest'
  | 'client-accepted'
  | 'client-changes'
  | 'pr-merged'
  | 'merge-approved'
  | 'release-approved'
  | 'waiting-answer'
  | 'refine';

export type TemplateId = 'starter' | 'web-client-project' | 'small-team' | 'internal-tool' | 'daily-routine';

/** How a built-in role is presented to people. */
export interface RoleText {
  /** Role name; also the default display name of an AI member hired for the role. */
  name: string;
  /** What the role does, one or two short sentences. */
  summary: string;
  /** What the role does not do (keeps roles apart). */
  notTheirJob: string;
  /** When to turn to a member holding the role. */
  whenToAsk: string;
}

/**
 * The text of a fix round limit decision item (PM-714): the subject, the body the integrator reads over MCP
 * and the CLI, and the label and consequence of each option. `{name}` style placeholders are filled by
 * `apps/server/src/core/inbox/fix-limit-text.ts`.
 */
export interface FixLimitItemText {
  title: string;
  summary: string;
  /** The counted rounds named in the summary; only the ones that are not zero. */
  parts: { changes: string; design: string; testsFailed: string; sendBacks: string };
  reasons: {
    no_ai_decider: string;
    passed_on: string;
    extra_exhausted: string;
    again: string;
    decider_timeout: string;
  };
  /** The extra rounds given of the three allowed; `over` when people gave more than that. */
  extras: { left: string; none: string; over: string };
  verdict: { title: string; repeat: string; now: string };
  rounds: {
    heading: string;
    technicalCount: string;
    /** The marker before a counted round: its number. */
    counted: string;
    technicalMarker: string;
    grantMarker: string;
    kind: {
      code_review: string;
      design_review: string;
      tests_failed: string;
      tests_failed_command: string;
      tests_failed_commit: string;
      send_back: string;
      send_back_no_note: string;
      branch_moved: string;
      branch_moved_moves: string;
      extra_round: string;
      extra_round_over: string;
    };
    notCounted: string;
    note: string;
  };
  options: {
    heading: string;
    recommended: string;
    unavailable: { replan: string; reassign: string };
    label: { replan: string; reassign: string; another_round: string };
    consequence: {
      replan: string;
      reassign: string;
      another_round: string;
      another_round_over: string;
    };
  };
  /** The line that says who the item is for and how it moves on. */
  footer: { integrator: string; owner: string };
}

/**
 * Default display names a template writes into a new project's configuration (after that
 * they are ordinary configuration data the team may rename), and the texts of the built-in
 * roles, duties and standard labels. Template names and descriptions are UI texts of the web
 * app (`TemplateSummary.nameKey` / `descriptionKey`).
 */
export interface TemplateLocale {
  checklist: {
    items: Record<ChecklistItemKey, { title: string; hint: string }>;
  };
  structuralReview: { question: string; details: string; approve: string; reject: string };
  /** Primary language subtag (BCP 47), e.g. "hu". */
  language: string;
  /** Time zone (IANA) of projects created in this language. */
  timezone: string;
  columns: Record<ColumnKey, { name: string; hint: string }>;
  stages: Record<StageKey, string>;
  duties: Record<DutyId, { name: string; description: string }>;
  roles: Record<BuiltInRoleId, RoleText>;
  members: Record<TemplateMemberKey, string>;
  specialties: Record<SpecialtyKey, string>;
  /** The bold labels of the project manager's report to whoever asked (PM-433), in the order of its lines. */
  projectManagerReport: {
    done: string;
    newCard: string;
    forwarded: string;
    waiting: string;
    /** What the waiting line says when the owner has nothing to do. */
    nothing: string;
  };
  /** The bold labels of the Operator's report to the owner (PM-447), in the order of its lines. */
  operatorReport: {
    done: string;
    /** The part of the one message per wake-up (PM-550) that lists the signals the owners must decide. */
    decision: string;
    approval: string;
    waiting: string;
    /** What the waiting line says when the owner has nothing to do. */
    nothing: string;
  };
  labels: Record<StandardLabelId, { name: string; meaning: string }>;
  /** The mail that carries a one-time login code (PM-669); `validUntil` is a date and time in `timezone`. */
  emailLoginCode: {
    subject: string;
    text: (input: { code: string; validUntil: string }) => string;
  };
  /** Text of the outgoing channel e-mail (PM-941). */
  email: {
    /** The short notice under the first mail a member sends to a contact (PM-1017). */
    firstNotice: (input: { member: string; project: string }) => string;
  };
  webPush: WebPushText;
  /** The fix round limit decision item the server makes (PM-714). */
  fixLimitItem: FixLimitItemText;
  /** What the owner's todo says when the Operator could not finish a queue item (PM-885). */
  operatorQueue: { failedAction(title: string): string; failedSummary: string };
  /** The headings of a system feedback sent as a card or an issue (PM-472). */
  systemFeedback: SystemFeedbackTextLabels;
  /** Name of an approval label generated for a stage, e.g. "Merge: approved". */
  stageApproval: (stageName: string) => string;
  /** Display name of a specialist, e.g. ("Frontend", "Developer") -> "Frontend developer". */
  specialist(specialty: string, roleName: string): string;
}

/**
 * Lowercases the first word of a role name when it is an ordinary capitalised word, so it
 * can follow a specialty ("Developer" -> "developer"); acronyms ("QA", "DevOps") stay.
 */
export function lowerFirstWord(name: string): string {
  const [first = '', ...rest] = name.split(' ');
  if (!/^\p{Lu}\p{Ll}*$/u.test(first)) return name;
  return [first.toLowerCase(), ...rest].join(' ');
}
