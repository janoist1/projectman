import { main, reportStartFailure } from './start';

// Server entry point. What it reads from the environment, and how the server starts, is in start.ts.
main().catch(reportStartFailure);
