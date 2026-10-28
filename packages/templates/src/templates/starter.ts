import { defineTemplate } from './draft';

/** An editable starting point for the team the owner builds with the Operator. */
export const starter = defineTemplate('starter', (t) => {
  const developer = t.hire('developer');
  return t.finish({
    columns: [t.column('ready'), t.column('development'), t.column('done')],
    stages: [
      t.stage('ready', 'queue', 'ready', []),
      { ...t.stage('dev', 'work', 'development', [developer]), duty: undefined, owners: [developer] },
      t.stage('done', 'done', 'done', []),
    ],
  });
});
