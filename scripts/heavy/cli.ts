// Runs a heavy command (the full test, the full type check, screenshots) at its turn in the machine's
// heavy-run queue, one at a time across members and the server's full test (PM-332).
//
//   npm run heavy -- [--label <text>] [--max-wait <seconds>] [--] <command> [args...]
//
// Exit status: the command's (128+n after a signal); 75 when --max-wait ran out; 2 for a bad call.
// docs/ARCHITECTURE.md has the queue ("Heavy-run queue").
import { runHeavy } from './run';

runHeavy({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stderr: (text) => process.stderr.write(text),
}).then((code) => process.exit(code));
