import type { ProjectManagerConfigPatch, ProjectManagerMemberChanges, TeamLimits } from '@projectman/shared';

/**
 * What each setting is for, in plain words, for the capability catalog of the project manager (PM-1468).
 * Each list is bound to the keys of the schema the project manager edits with, so a new field without a note
 * (or a note of a removed field) does not type-check. A note is general: it holds for any project, so it names
 * no card and no decision, and it makes no claim about who may change the setting (the code's own lists do).
 */

/** The fields of a member the project manager may change (`member_update`). */
export const MEMBER_SETTING_NOTES = {
  complexityLimit:
    'The largest card, in complexity points, the member is given automatically. Null removes the limit.',
  specialtyLabels:
    'Labels the member specializes in; automatic assignment prefers it for cards with these labels.',
  email: 'The e-mail channel of an AI member: whether it is on and whether it may send without approval.',
  provider:
    'Which AI provider runs the member (for example Claude, Codex, Gemini). Some providers are paid per use.',
  effort:
    'How much the member thinks before it answers: a higher effort is slower and uses more of the plan. Null restores the provider default.',
  autoCompactWindowTokens:
    'The conversation size, in tokens, at which the member’s conversation is compacted. Null uses the project’s value.',
  outboundNetwork: 'Whether the commands the member runs may reach the network.',
  machineAccess: 'Whether the member may put work for the owners’ own machine into their queue.',
  cheapSubagent: 'The cheaper model the member hands text-heavy, logic-light work to. Null switches it off.',
  specialty: 'A short free-text note about what the member is good at. An empty string removes it.',
  model: 'The model the member runs on, within its provider.',
  schedule: 'Times when the member starts by itself, for example a daily review. Null removes the schedule.',
  onLeave: 'Sends the member on leave (no new work) or calls it back.',
  instructions: 'The member’s own standing instructions, added to its role’s. An empty string clears them.',
  permissionMode:
    'How much the member may do without asking: ask for everything, accept edits, plan only, or decide on its own (auto).',
  approver: 'Who answers when the member’s tool asks for permission: a person, an AI member or nobody.',
  capacity: 'How many conversations or cards the member works on at the same time (1 to 5).',
  role: 'The role the member holds; an AI member holds exactly one.',
} satisfies Record<keyof ProjectManagerMemberChanges, string>;

/** The `limits` of the project, one note per field; the patch keys them as `limits.<field>`. */
export const TEAM_LIMIT_NOTES = {
  aiEnabled:
    'The master switch: when off, no AI session starts or resumes in the project; running ones finish.',
  maxConcurrentAi: 'A cap on AI sessions working at the same time across the project. Null removes the cap.',
  pauseAbovePlanUsagePercent: 'New AI work pauses above this percentage of the subscription plan’s usage.',
  warnAboveSessionTokens:
    'A session that uses this many tokens raises one warning to the owners. Null switches it off.',
  minFreeDiskGb: 'Below this much free disk space no new AI session starts; 0 turns the check off.',
  autoCompactWindowTokens:
    'The conversation size, in tokens, at which members’ conversations are compacted. Null uses the default.',
  loopWatch:
    'When AI members writing to each other on a card without progress count as a loop that is reported.',
  maxFixRounds: 'How many fix rounds a card gets before a person decides how to go on.',
  seniorWaitMinutes:
    'How long a card for a senior developer waits for one before another developer may take it.',
  obligationMinutes:
    'How long an open obligation waits before each escalation step (reminder, project manager, integrator).',
  tempWorkers:
    'Temporary extra workers hired for busy periods: whether on, how many, which role and the largest card they take.',
} satisfies Record<keyof TeamLimits, string>;

/** The settings of the project the project manager changes with `config_patch`; `limits` is described field by field above. */
export const PROJECT_SETTING_NOTES = {
  email: 'Turns the project’s e-mail channel on or off.',
  project:
    'The project’s name, language and time zone. The language is the language of the team’s messages and role texts.',
  roleOverrides:
    'The project’s own text of a built-in role (summary, what is not its job, when to ask, instructions, duties). Null resets a role.',
  roles:
    'Custom roles of the project: a name, a summary, what is not their job, their duties and instructions.',
  releaseFourEyes: 'Whether a release needs a second person’s approval besides the one who asks for it.',
  operatorWatch:
    'How far the project manager goes on its own when it watches the project: report, unblock or drive.',
  cardMover:
    'Who moves a finished card to the next stage: the worker, the project manager or a named person.',
  taskCreateAccess: 'The lowest access level of a person who may open a new card.',
  projectManagerMoves:
    'How far the project manager moves cards by itself: queue moves and starting work, or starting work only.',
  projectManagerLifecycle:
    'The lifecycle actions the project manager may take on its own: assign, cancel, reopen.',
  prerequisiteOverride:
    'Who may start a card whose prerequisite is still open: only people, or the project manager too.',
  memberInvolvement:
    'Who may involve a member on a card it has no role on: only people, or the project manager too.',
  projectManagerAuthority:
    'Whether the project manager acts on its own only outside the owner-only list, or only on an owner’s request.',
  prioritySetters: 'Who besides people may set a card’s priority.',
  complexitySetters: 'The duties whose holders may set a card’s complexity points.',
  assigneeFit:
    'Whether the system keeps a named assignee within its complexity limit and specialty (automatic), or not.',
  ruleReasons: 'The project’s own explanation of a team rule, shown when the rule refuses something.',
  ownerDecisionTopics: 'The topics on which a decision always needs an owner.',
  merger: 'The member whose approval merges a card.',
  mergeAfterReview: 'Whether the merger’s own approval at review queues the merge by itself.',
  startCondition:
    'Combines stages, effective priority and inherited labels for automatic starts, with hold labels and a grace period. Urgent and sufficient stage matches act immediately. Null restores queue starts.',
  operationsReview: 'Whether the project manager sends the owners a short weekly operations review (weekly or off).',
  contacts: 'The people outside the team the project keeps as contacts.',
  viewerRecipients: 'Whom a read-only viewer may write to.',
  repoMerge: 'Per repository: whether a card’s work must be merged before the card is done.',
  repoDocs: 'Per repository: where the project’s documents live.',
  repoHeavyChecks: 'Per repository: which commands are heavy and run only on the shared machine.',
  repoHandoverCheck: 'Per repository: the check a card has to pass before it moves into review.',
  repoScreenshots: 'Per repository: the command that takes screenshots of the interface.',
  repoReviewTest: 'Per repository: the full test the server runs on handed-over work.',
  repoFullTestAtMerge: 'Per repository: whether the full test runs only at the merge.',
  repoComputeJobs: 'Per repository: the compute jobs the hub may start.',
  boundary:
    'Owner-controlled delegation: whether it is on, and the timeout in seconds the lead developer has.',
  feedback:
    'The project’s feedback tool: the places it accepts feedback from and the markers that block a report.',
  pipeline:
    'The stages, columns and labels of the board and the gates between stages, with the rules for who may set which label.',
  labels: 'One pipeline label at a time: its name, color and meaning. Null removes the color or the meaning.',
} satisfies Record<Exclude<keyof ProjectManagerConfigPatch, 'limits'>, string>;
