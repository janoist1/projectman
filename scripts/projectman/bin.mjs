#!/usr/bin/env node
// The `projectman` command (PM-765): a thin client of the integrator's REST and MCP endpoints.
// It runs TypeScript through tsx, like the other scripts of this repository.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('./cli.ts');
const { processIo } = await import('./io.ts');
process.exitCode = await main(process.argv.slice(2), processIo());
// Standard input may still be open (a terminal, a pipe); the command is done.
process.exit();
