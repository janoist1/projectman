import { defineTemplate, hasLabel } from './draft';

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
      t.stage('code_review', 'step', 'review', [codeReview]),
      t.stage('integration', 'step', 'review', [devops], hasLabel('code-review-ok')),
      t.stage('qa', 'step', 'review', [qa]),
      t.stage('client_test', 'step', 'client_test', [communication, t.owner], hasLabel('qa-ok')),
      t.stage(
        'merge',
        'step',
        'awaiting_release',
        'final_decision',
        hasLabel('client-accepted'),
        hasLabel('merge-approved'),
      ),
      t.stage('release', 'release', 'awaiting_release', [devops], hasLabel('release-approved')),
      t.stage('done', 'done', 'done', []),
    ],
  });
});
