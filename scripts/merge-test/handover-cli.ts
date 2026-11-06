import { runHandoverCheck } from './handover-run';

void runHandoverCheck(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
