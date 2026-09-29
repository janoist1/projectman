import { checkPassed, defineTemplate, humanApproval } from './draft';

/** The owner, one developer and a code reviewer; the owner closes reviewed work. */
export const smallTeam = defineTemplate('small-team', (t) => {
  const developer = t.hire('developer');
  const codeReview = t.hire('code_review');

  return t.finish({
    columns: [t.column('ready'), t.column('development'), t.column('review'), t.column('done')],
    stages: [
      t.stage('ready', 'queue', 'ready', []),
      t.stage('dev', 'work', 'development', [developer]),
      t.stage('code_review', 'review', 'review', [codeReview]),
      t.stage('done', 'done', 'done', [], checkPassed('code_review'), humanApproval(t.owner)),
    ],
  });
});
