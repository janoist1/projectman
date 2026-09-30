import { lowerFirstWord, type TemplateLocale } from './types';

/** English default display names and role texts. */
export const en: TemplateLocale = {
  language: 'en',
  timezone: 'UTC',
  columns: {
    ready: { name: 'Ready', hint: 'Selected, work can start' },
    development: { name: 'In development', hint: 'A developer is working on it' },
    in_progress: { name: 'In progress', hint: 'Being worked on' },
    review: { name: 'In review', hint: 'Being checked' },
    client_test: { name: 'Client test', hint: 'The client is trying it out' },
    awaiting_merge: { name: 'Awaiting merge', hint: 'Merged on a human decision' },
    awaiting_release: { name: 'Awaiting release', hint: 'Merge and release on a human decision' },
    done: { name: 'Done', hint: 'Closed' },
  },
  stages: {
    ready: 'Ready',
    dev: 'Development',
    work: 'In progress',
    code_review: 'Code review',
    integration: 'Integration',
    qa: 'QA',
    client_test: 'Client test',
    merge: 'Merge',
    release: 'Release',
    done: 'Done',
  },
  duties: {
    prioritization: {
      name: 'Prioritization',
      description: 'Order work by value and urgency. Escalate conflicting priorities.',
    },
    requirements_analysis: {
      name: 'Requirements analysis',
      description: 'Clarify goals and acceptance criteria. Resolve unknowns before delivery.',
    },
    task_breakdown: {
      name: 'Task breakdown',
      description: 'Split work into testable tasks. Record dependencies.',
    },
    triage: {
      name: 'Triage',
      description: 'Assess incoming requests and bugs. Route them to the right people.',
    },
    scheduling: {
      name: 'Scheduling',
      description: 'Track dates and blocked work. Remind the next responsible person.',
    },
    technical_direction: {
      name: 'Technical direction',
      description: 'Plan architecture and technical choices. Explain risks and tradeoffs.',
    },
    ux_design: {
      name: 'UX design',
      description: 'Design screens and interactions. Check the implemented experience.',
    },
    implementation: {
      name: 'Implementation',
      description: 'Implement tasks with tests. Open a pull request for review.',
    },
    docs: {
      name: 'Documentation',
      description: 'Write and maintain technical documentation. Verify examples.',
    },
    content: { name: 'Content', description: 'Write and edit product content. Follow the agreed voice.' },
    translation: {
      name: 'Translation',
      description: 'Translate and check localizations. Preserve meaning and placeholders.',
    },
    maintenance: {
      name: 'Maintenance',
      description: 'Update dependencies and reduce technical debt. Keep changes focused.',
    },
    code_review: {
      name: 'Code review',
      description: 'Review correctness and maintainability. Report actionable findings.',
    },
    security_review: {
      name: 'Security review',
      description: 'Review access and sensitive data handling. Report risks without exposing secrets.',
    },
    testing_acceptance: {
      name: 'Testing and acceptance',
      description: 'Test behavior against acceptance criteria. Record reproducible failures.',
    },
    deployment: {
      name: 'Deployment',
      description: 'Deploy approved changes and verify health. Record the deployed version.',
    },
    release_approval: {
      name: 'Release approval',
      description: 'Make the explicit release decision. Only humans may hold this duty.',
    },
    monitoring: {
      name: 'Monitoring',
      description: 'Observe service and team health. Report anomalies with evidence.',
    },
    client_communication: {
      name: 'Client communication',
      description: 'Draft client updates and test requests. Obtain approval before sending.',
    },
    support: { name: 'Support', description: 'Reproduce reported problems. Prepare clear support tasks.' },
    standup_facilitation: {
      name: 'Standup facilitation',
      description: 'Collect progress and blockers. Keep the meeting focused.',
    },
    refinement_facilitation: {
      name: 'Refinement facilitation',
      description: 'Prepare and clarify upcoming work. Record open questions.',
    },
    retro_facilitation: {
      name: 'Retro facilitation',
      description: 'Collect lessons from completed work. Agree on concrete improvements.',
    },
    process_improvement: {
      name: 'Process improvement',
      description: 'Identify recurring friction. Propose measurable changes.',
    },
    research: {
      name: 'Research',
      description: 'Investigate a focused question. Report sources and uncertainty.',
    },
    final_decision: {
      name: 'Final decision',
      description: 'Settle escalated decisions. Only humans may hold this duty.',
    },
  },
  roles: {
    operator: {
      name: 'Operator',
      summary:
        'Runs and oversees the system, brings any work that goes off track back on course, and has the final say.',
      notTheirJob: 'Does not do the day-to-day tasks: directs the team rather than replacing it.',
    },
    product_owner: {
      name: 'Product owner',
      summary: 'Decides what gets built and in what order, and accepts the finished work.',
      notTheirJob: 'Does not write specifications or schedule the work.',
    },
    project_manager: {
      name: 'Project manager',
      summary: 'Runs the schedule: standups, planning, deadlines, reminders and the weekly report.',
      notTheirJob: 'Does not set priorities or run the retro.',
    },
    business_analyst: {
      name: 'Business analyst',
      summary:
        "Turns the client's requests into precise descriptions and acceptance criteria, and asks back before work starts.",
      notTheirJob: 'Does not schedule work or design the technical solution.',
    },
    architect: {
      name: 'Architect',
      summary:
        'Designs the technical solution before development, breaks it down into tasks, and reviews the bigger decisions.',
      notTheirJob: 'Does not review the code line by line.',
    },
    designer: {
      name: 'Designer',
      summary:
        'Creates screen designs and clickable mockups, and checks that the finished interface follows the design.',
      notTheirJob: 'Does not code the interface.',
    },
    developer: {
      name: 'Developer',
      summary: 'Implements the task on its own branch, together with tests, and opens a pull request.',
      notTheirJob: 'Does not approve their own work.',
    },
    code_review: {
      name: 'Code reviewer',
      summary:
        'Reviews every pull request before integration and points out what blocks it, precise to file and line.',
      notTheirJob: 'Does not write or fix code.',
    },
    security_review: {
      name: 'Security reviewer',
      summary: 'Reviews access control, secrets handling and risky code paths in pull requests.',
      notTheirJob: 'Does not fix anything, only reports.',
    },
    qa: {
      name: 'QA',
      summary:
        'Tests finished work on the integration environment and in the browser, and reports bugs that can be reproduced.',
      notTheirJob: 'Does not fix the bugs.',
    },
    devops: {
      name: 'DevOps',
      summary: 'Deploys, and looks after the servers and the infrastructure.',
      notTheirJob: 'Releases to production only after approval, and does not build features.',
    },
    communication: {
      name: 'Communication',
      summary:
        'Writes the test requests, the summaries and the emails to the client, for approval before they are sent.',
      notTheirJob: 'Does not decide for the client.',
    },
    support: {
      name: 'Support',
      summary: 'Takes in bug reports, reproduces them, and turns them into well-prepared cards.',
      notTheirJob: 'Does not fix the bugs.',
    },
    researcher: {
      name: 'Researcher',
      summary:
        'Does short investigations: which library to use, whether an approach is viable, what a competitor does.',
      notTheirJob: 'Does not implement anything, only recommends.',
    },
    maintainer: {
      name: 'Maintainer',
      summary:
        'Updates dependencies, fixes flaky tests and reduces technical debt. Works best on a schedule.',
      notTheirJob: 'Does not build new features.',
    },
    coach: {
      name: 'Coach',
      summary:
        'Owns the retros: collects observations and proposes improvements to the roles and the process.',
      notTheirJob: 'Does not put changes into effect: others approve them.',
    },
    watchdog: {
      name: 'Watchdog',
      summary:
        "The operator's helper: flags when a member is stuck, goes in circles, uses too much or oversteps their role.",
      notTheirJob: 'Does not intervene, only flags.',
    },
    content: {
      name: 'Content',
      summary: 'Writes copy, SEO texts and marketing material.',
      notTheirJob: 'Does not build the interface.',
    },
    translator: {
      name: 'Translator',
      summary: 'Manages the texts of multilingual interfaces and keeps the terminology consistent.',
      notTheirJob: 'Does not write new content.',
    },
    docs: {
      name: 'Technical writer',
      summary: 'Keeps the documentation and the decision log up to date.',
      notTheirJob: 'Does not make decisions, only records them.',
    },
  },
  members: {
    daily_worker: 'Daily worker',
  },
  specialties: {
    frontend: 'Frontend',
    backend: 'Backend',
  },
  templates: {
    'web-client-project': {
      name: 'Web client project',
      description:
        'A web project built for a client: developers, code review, integration, QA and client test; merge and release on a human decision.',
    },
    'small-team': {
      name: 'Small team',
      description: 'One developer and a code reviewer; the owner decides when work is done.',
    },
    'internal-tool': {
      name: 'Internal tool',
      description: 'Two developers, code review and QA, no client test; the owner decides on merges.',
    },
    'daily-routine': {
      name: 'Daily routine',
      description: 'One scheduled member for recurring daily work.',
    },
  },
  labels: {
    'code-review-ok': {
      name: 'Code review ok',
      meaning: 'Someone other than the author reviewed the change and found nothing blocking.',
    },
    'code-review-changes': {
      name: 'Code review: changes needed',
      meaning: 'The review found changes to make; the comment says what.',
    },
    'code-review-blocked': {
      name: 'Code review: blocked',
      meaning: 'The review cannot be done now; the comment says why.',
    },
    'security-ok': {
      name: 'Security review ok',
      meaning: 'Access, secrets and risky code paths were reviewed; nothing blocking.',
    },
    'security-changes': {
      name: 'Security review: changes needed',
      meaning: 'A security problem was found; the comment says what.',
    },
    'qa-ok': { name: 'QA ok', meaning: 'Tested; the acceptance criteria hold.' },
    'qa-failed': {
      name: 'QA: failed',
      meaning: 'Testing found a defect; the comment says where and how to reproduce it.',
    },
    'qa-retest': { name: 'Retest needed', meaning: 'Needs testing again after a fix.' },
    'client-accepted': { name: 'Client accepted', meaning: 'The client tried it and accepted it.' },
    'client-changes': {
      name: 'Client: changes requested',
      meaning: 'The client tried it and asks for changes; the comment says what.',
    },
    'pr-merged': {
      name: 'PR merged',
      meaning: "The task's pull request is merged; set automatically from GitHub.",
    },
    'merge-approved': {
      name: 'Merge approved',
      meaning: 'An authorized human approved the merge. Only humans may set it.',
    },
    'release-approved': {
      name: 'Release approved',
      meaning: 'An authorized human approved the release. Only humans may set it.',
    },
    'waiting-answer': {
      name: 'Waiting for an answer',
      meaning: 'Waiting for an outside answer; the task cannot move forward meanwhile.',
    },
  },
  stageApproval: (stageName) => `${stageName}: approved`,
  specialist: (specialty, roleName) => `${specialty} ${lowerFirstWord(roleName)}`,
};
