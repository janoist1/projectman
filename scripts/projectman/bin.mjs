#!/usr/bin/env node
// The `projectman` command (PM-765): a thin client of the integrator's REST and MCP endpoints.
// From a checkout it runs TypeScript through tsx, like the other scripts of this repository; the engine app
// ships the same entry bundled (`scripts/projectman/cli.js`, PM-1429).
import { register } from 'tsx/esm/api';

register();
await import('./entry.ts');
