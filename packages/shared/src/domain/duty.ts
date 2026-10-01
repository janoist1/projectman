import { z } from 'zod';

export const DUTY_IDS = [
  'prioritization',
  'requirements_analysis',
  'task_breakdown',
  'triage',
  'scheduling',
  'technical_direction',
  'boundary_authorization',
  'ux_design',
  'implementation',
  'docs',
  'content',
  'translation',
  'maintenance',
  'code_review',
  'security_review',
  'testing_acceptance',
  'deployment',
  'release_approval',
  'monitoring',
  'client_communication',
  'support',
  'standup_facilitation',
  'refinement_facilitation',
  'retro_facilitation',
  'process_improvement',
  'research',
  'final_decision',
] as const;
export const DutyId = z.enum(DUTY_IDS);
export type DutyId = z.infer<typeof DutyId>;
/** Duty groups in display order (the duties matrix shows one section per group). */
export const DUTY_GROUPS = ['direction', 'delivery', 'quality', 'release', 'communication', 'team'] as const;
export type DutyGroup = (typeof DUTY_GROUPS)[number];
export interface DutyDefinition {
  id: DutyId;
  group: DutyGroup;
  holders: 'human' | 'ai' | 'both';
  prompt: string;
  toolPolicy: 'read_only' | 'task_worktree';
  meetings: readonly string[];
  events: readonly string[];
  recommended: boolean;
}
export const DUTIES: Record<DutyId, DutyDefinition> = {
  boundary_authorization: {
    id: 'boundary_authorization',
    group: 'direction',
    holders: 'both',
    prompt:
      'Decide delegated external operations with decide_boundary_request after checking the exact target and scope. Never decide your own request. Cost, production or release or main publication, new accounts or secrets, and permanent host boundary expansion belong to the owner. Gates and release approvals remain human-only. Use get_boundary_request to inspect requests; late decisions are refused. A team message may also hand you a permission request of another member (a tool call its CLI asks about): read its exact content and answer it with decide_permission_request, always with a reason. Allow only a routine step that plainly belongs to the task, deny what plainly does not, and escalate the rest to a person. Always escalate: spending money; new accounts, tokens or secrets; a lasting widening of what the host reaches; the live system, a release, publishing or main; a request you cannot read completely or fully understand; your own requests. A request that is cut off or unclear is never allowed.',
    toolPolicy: 'read_only',
    meetings: [],
    events: [],
    recommended: false,
  },
  prioritization: {
    id: 'prioritization',
    group: 'direction',
    holders: 'both',
    prompt: 'Prioritize work by agreed value and urgency; ask a human to settle conflicts.',
    toolPolicy: 'read_only',
    meetings: [],
    events: [],
    recommended: false,
  },
  requirements_analysis: {
    id: 'requirements_analysis',
    group: 'direction',
    holders: 'both',
    prompt:
      'Clarify goals, edge cases and acceptance criteria with ask_human; record requirements with update_task.',
    toolPolicy: 'read_only',
    meetings: [],
    events: [],
    recommended: false,
  },
  task_breakdown: {
    id: 'task_breakdown',
    group: 'direction',
    holders: 'both',
    prompt: 'Split work into independently testable tasks with create_task and record dependencies.',
    toolPolicy: 'read_only',
    meetings: [],
    events: [],
    recommended: false,
  },
  triage: {
    id: 'triage',
    group: 'direction',
    holders: 'both',
    prompt:
      'Assess incoming requests, reproduce reported issues and route them to the appropriate duty holders.',
    toolPolicy: 'read_only',
    meetings: [],
    events: [],
    recommended: false,
  },
  scheduling: {
    id: 'scheduling',
    group: 'direction',
    holders: 'both',
    prompt: 'Track deadlines, blocked work and agreed plans; send concise reminders with send_message.',
    toolPolicy: 'read_only',
    meetings: [],
    events: [],
    recommended: false,
  },
  technical_direction: {
    id: 'technical_direction',
    group: 'direction',
    holders: 'both',
    prompt:
      'Read the code and propose technical plans with risks and tradeoffs; escalate major decisions to a human.',
    toolPolicy: 'read_only',
    meetings: [],
    events: [],
    recommended: false,
  },
  ux_design: {
    id: 'ux_design',
    group: 'direction',
    holders: 'both',
    prompt:
      'Create designs and mockups in the task worktree and describe all interface states and handoff requirements.',
    toolPolicy: 'task_worktree',
    meetings: [],
    events: [],
    recommended: false,
  },
  implementation: {
    id: 'implementation',
    group: 'delivery',
    holders: 'both',
    prompt:
      'Implement the task and tests only in its worktree; run checks, open a pull request and link it with link_pull_request.',
    toolPolicy: 'task_worktree',
    meetings: [],
    events: ['task_stage_changed'],
    recommended: false,
  },
  docs: {
    id: 'docs',
    group: 'delivery',
    holders: 'both',
    prompt:
      'Write accurate documentation in the task worktree; verify examples against the code and link the pull request.',
    toolPolicy: 'task_worktree',
    meetings: [],
    events: [],
    recommended: false,
  },
  content: {
    id: 'content',
    group: 'delivery',
    holders: 'both',
    prompt: 'Write and edit content in the task worktree using the agreed voice; ask about missing facts.',
    toolPolicy: 'task_worktree',
    meetings: [],
    events: [],
    recommended: false,
  },
  translation: {
    id: 'translation',
    group: 'delivery',
    holders: 'both',
    prompt:
      'Translate in the task worktree, preserving meaning, formatting and placeholders; validate locale completeness.',
    toolPolicy: 'task_worktree',
    meetings: [],
    events: [],
    recommended: false,
  },
  maintenance: {
    id: 'maintenance',
    group: 'delivery',
    holders: 'both',
    prompt:
      'Maintain dependencies and tests in the task worktree; keep changes small and verify compatibility.',
    toolPolicy: 'task_worktree',
    meetings: [],
    events: [],
    recommended: false,
  },
  code_review: {
    id: 'code_review',
    group: 'quality',
    holders: 'both',
    prompt:
      'Review diffs for correctness, errors and missing tests. Record the verdict as the matching label with update_task, findings in the note, and send them to the author; never review your own work.',
    toolPolicy: 'read_only',
    meetings: [],
    events: ['task_stage_changed'],
    recommended: false,
  },
  security_review: {
    id: 'security_review',
    group: 'quality',
    holders: 'both',
    prompt:
      'Review authentication, authorization, injection and secret handling. Record the verdict as the matching label with update_task, evidence in the note; never review your own work or disclose secrets.',
    toolPolicy: 'read_only',
    meetings: [],
    events: ['task_stage_changed'],
    recommended: false,
  },
  testing_acceptance: {
    id: 'testing_acceptance',
    group: 'quality',
    holders: 'both',
    prompt:
      'Test expected behavior and risky paths in a test environment. Record the result as the matching label with update_task, reproduction steps in the note; never certify your own work.',
    toolPolicy: 'read_only',
    meetings: [],
    events: ['task_stage_changed'],
    recommended: false,
  },
  deployment: {
    id: 'deployment',
    group: 'release',
    holders: 'both',
    prompt:
      'Deploy the exact approved change and verify health; production changes require an explicit human decision. Record environment and version.',
    toolPolicy: 'read_only',
    meetings: [],
    events: ['task_stage_changed'],
    recommended: false,
  },
  release_approval: {
    id: 'release_approval',
    group: 'release',
    holders: 'human',
    prompt: '',
    toolPolicy: 'read_only',
    meetings: [],
    events: [],
    recommended: false,
  },
  monitoring: {
    id: 'monitoring',
    group: 'release',
    holders: 'both',
    prompt:
      'Observe service and team health, stalled work and unusual usage; report evidence to humans without intervening.',
    toolPolicy: 'read_only',
    meetings: [],
    events: ['observation'],
    recommended: false,
  },
  client_communication: {
    id: 'client_communication',
    group: 'communication',
    holders: 'both',
    prompt:
      'Draft concise client updates and test requests; obtain a human decision before sending anything outside the team.',
    toolPolicy: 'read_only',
    meetings: [],
    events: [],
    recommended: false,
  },
  support: {
    id: 'support',
    group: 'communication',
    holders: 'both',
    prompt:
      'Collect reproduction steps, expected behavior and environment; create support tasks without exposing customer data.',
    toolPolicy: 'read_only',
    meetings: [],
    events: [],
    recommended: false,
  },
  standup_facilitation: {
    id: 'standup_facilitation',
    group: 'team',
    holders: 'both',
    prompt: 'Collect progress, next steps and blockers for standups; send a brief factual summary.',
    toolPolicy: 'read_only',
    meetings: ['standup'],
    events: [],
    recommended: false,
  },
  refinement_facilitation: {
    id: 'refinement_facilitation',
    group: 'team',
    holders: 'both',
    prompt:
      'Facilitate refinement by clarifying scope, dependencies and open questions; record agreed actions.',
    toolPolicy: 'read_only',
    meetings: ['refinement'],
    events: [],
    recommended: false,
  },
  retro_facilitation: {
    id: 'retro_facilitation',
    group: 'team',
    holders: 'both',
    prompt:
      'Facilitate retros using task evidence; propose at most three concrete improvements and ask humans to decide.',
    toolPolicy: 'read_only',
    meetings: ['retro'],
    events: [],
    recommended: true,
  },
  process_improvement: {
    id: 'process_improvement',
    group: 'team',
    holders: 'both',
    prompt:
      'Identify recurring process friction from evidence and propose measurable improvements; never change configuration yourself.',
    toolPolicy: 'read_only',
    meetings: [],
    events: ['observation'],
    recommended: false,
  },
  research: {
    id: 'research',
    group: 'team',
    holders: 'both',
    prompt:
      'Research a focused question using primary sources; report recommendation, alternatives, sources and uncertainties.',
    toolPolicy: 'read_only',
    meetings: [],
    events: [],
    recommended: false,
  },
  final_decision: {
    id: 'final_decision',
    group: 'team',
    holders: 'human',
    prompt: '',
    toolPolicy: 'read_only',
    meetings: [],
    events: [],
    recommended: false,
  },
};
