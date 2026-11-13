// Runs a heavy command (the full test, the full type check, screenshots) at its turn in the machine's
// pool of heavy-run places, which the members' runs and the server's full test share (PM-332, PM-1278).
//
//   npm run heavy -- [--label <text>] [--max-wait <seconds>] [--places all|merge-test|<n>|<min>-<max>] [--] <command> [args...]
//
// Exit status: the command's (128+n after a signal); 75 when --max-wait ran out; 78 when the pool cannot
// be used; 79 when the same command of the session is already running; 2 for a bad call.
// docs/modules/scripts.md has the pool ("Heavy-run queue").
import { runHeavy } from './run';

runHeavy({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stderr: (text) => process.stderr.write(text),
}).then((code) => process.exit(code));
