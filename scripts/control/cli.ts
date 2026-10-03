// Pauses and resumes the whole instance over its control socket (PM-219; docs/DEPLOY.md has the procedure).
//
//   npm run control -- pause [--wait] [--force-after <s>] [--reason <text>] [--timeout <s>]
//   npm run control -- resume | force | status
//   (all: [--home <dir>] [--json]; the home is PROJECTMAN_HOME or ~/.projectman)
//
// `pause --wait` returns when every session has stopped at a safe point, and prints the ones that have
// not. Exit status: 0 done, 1 refused, failed or timed out, 2 the server does not run.
import { runControl } from './client';

runControl(process.argv.slice(2)).then((code) => process.exit(code));
