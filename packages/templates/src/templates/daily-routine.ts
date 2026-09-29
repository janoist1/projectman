import { defineTemplate } from './draft';

/** The owner and one scheduled member for recurring daily work. */
export const dailyRoutine = defineTemplate('daily-routine', (t) => {
  const worker = t.hire('scheduled');

  return t.finish({
    columns: [t.column('ready'), t.column('in_progress'), t.column('done')],
    stages: [
      t.stage('ready', 'queue', 'ready', []),
      t.stage('work', 'work', 'in_progress', [worker]),
      t.stage('done', 'done', 'done', []),
    ],
  });
});
