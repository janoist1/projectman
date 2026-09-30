import { defineTemplate, hasLabel } from './draft';

/** Two developers, code review and QA for an internal tool: no client test, the owner merges. */
export const internalTool = defineTemplate('internal-tool', (t) => {
  const first = t.hire('developer');
  const second = t.hire('developer');
  const codeReview = t.hire('code_review');
  const qa = t.hire('qa');

  return t.finish({
    columns: [
      t.column('ready'),
      t.column('development'),
      t.column('review'),
      t.column('awaiting_merge'),
      t.column('done'),
    ],
    stages: [
      t.stage('ready', 'queue', 'ready', []),
      t.stage('dev', 'work', 'development', [first, second]),
      t.stage('code_review', 'review', 'review', [codeReview]),
      t.stage('qa', 'test', 'review', [qa], hasLabel('code-review-ok')),
      t.stage('merge', 'merge', 'awaiting_merge', [t.owner], hasLabel('qa-ok'), hasLabel('merge-approved')),
      t.stage('done', 'done', 'done', []),
    ],
  });
});
