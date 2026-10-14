import type { ModuleEntry } from '../module-map';

export const coreInbox: ModuleEntry = {
  id: 'core/inbox',
  layer: 'core',
  target: 'core/inbox',
  pass: 'split',
  paths: [
    'core/inbox/',
    'domain/inbox.ts',
    'domain/approval-questions.ts',
    'domain/card-questions.ts',
    'domain/agent-question.ts',
    'domain/question-closing.ts',
    'domain/question-screening.ts',
    'domain/open-question-label.ts',
  ],
  sealed: true,
};
