import { runMergeTest } from './run';

process.exitCode = runMergeTest(process.argv.slice(2));
