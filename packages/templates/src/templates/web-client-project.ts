import { checkPassed, defineTemplate, humanApproval } from './draft';

/**
 * A web project built for a client (the setup the owner's first team works in): standing
 * DevOps, code review, QA and communication members plus a frontend and a backend
 * developer. Code review happens before the integration deploy; merge and release wait
 * for the owner's decision.
 */
export const webClientProject = defineTemplate('web-client-project', (t) => {
  const devops = t.hire('devops');
  const codeReview = t.hire('code_review');
  const qa = t.hire('qa');
  const communication = t.hire('communication');
  const frontend = t.hire('developer', { specialty: 'frontend' });
  const backend = t.hire('developer', { specialty: 'backend' });

  return t.finish({
    columns: [
      t.column('ready'),
      t.column('development'),
      t.column('review'),
      t.column('client_test'),
      t.column('awaiting_release'),
      t.column('done'),
    ],
    stages: [
      t.stage('ready', 'queue', 'ready', []),
      t.stage('dev', 'work', 'development', [frontend, backend]),
      t.stage('code_review', 'review', 'review', [codeReview]),
      t.stage('integration', 'deploy', 'review', [devops], checkPassed('code_review')),
      t.stage('qa', 'test', 'review', [qa]),
      t.stage('client_test', 'client_test', 'client_test', [communication, t.owner], checkPassed('qa')),
      t.stage(
        'merge',
        'merge',
        'awaiting_release',
        [t.owner],
        checkPassed('client_test'),
        humanApproval(t.owner),
      ),
      t.stage('release', 'release', 'awaiting_release', [devops], humanApproval(t.owner)),
      t.stage('done', 'done', 'done', []),
    ],
  });
});
