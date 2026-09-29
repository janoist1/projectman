import { lowerFirstWord, type TemplateLocale } from './types';

/** English default display names. */
export const en: TemplateLocale = {
  language: 'en',
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
  roles: {
    developer: 'Developer',
    code_review: 'Code reviewer',
    security_review: 'Security reviewer',
    qa: 'QA',
    devops: 'DevOps',
    communication: 'Communication',
    project_manager: 'Project manager',
    docs: 'Technical writer',
    scheduled: 'Daily worker',
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
  specialist: (specialty, roleName) => `${specialty} ${lowerFirstWord(roleName)}`,
};
