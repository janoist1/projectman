/** The rules `teamRules` can list, in the order the "How we work" page shows them. Kept apart so the configuration schema can name them. */
export const TEAM_RULE_IDS = [
  'new_card',
  'gates_in_order',
  'approvals',
  'self_review',
  'start_order',
  'priority_setters',
  'complexity_setters',
  'assignee_fit',
  'acceptance',
  'project_manager_rights',
  'fix_limit',
  'refinement',
  'waiting_answer',
  'viewer_recipients',
] as const;
export type TeamRuleId = (typeof TEAM_RULE_IDS)[number];

/** The longest reason a team writes for a rule (`team.ruleReasons`). */
export const RULE_REASON_MAX = 300;
