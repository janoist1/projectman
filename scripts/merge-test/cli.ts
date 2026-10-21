import { runMergeTest } from './run';

void runMergeTest(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
