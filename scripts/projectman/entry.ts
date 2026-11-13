// The `projectman` command's entry (PM-765, PM-1429): runs the client on the process streams. It needs no tsx:
// `bin.mjs` imports it through tsx from a checkout, and the engine app bundles it into `scripts/projectman/cli.js`.
import { main } from './cli';
import { processIo } from './io';

process.exitCode = await main(process.argv.slice(2), processIo());
// Standard input may still be open (a terminal, a pipe); the command is done.
process.exit();
