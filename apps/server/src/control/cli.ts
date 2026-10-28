// The control relay the cloud container runs for the admin channel (PM-749; docs/AWS.md "Release control"):
//
//   node apps/server/dist/control/cli.js /data/control.sock < one-request-line
//
// It is bundled into dist/control/cli.js next to the server (`scripts/build.mjs`). The logic is in relay.ts.
import { runControlRelay } from './relay';

const code = await runControlRelay(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
});
process.exitCode = code;
process.stdin.destroy();
