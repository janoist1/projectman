// The cloud board, set up from the owner's machine (PM-532, PM-534).
//
//   npm run cloud -- preflight [--config <file>]
//   npm run cloud -- aws [--dry-run] [--rotate-keys] [--config <file>]
//   npm run cloud -- ses plan|configure|request-production|check [--config <file>]
//   SES configure and request-production accept --dry-run; live execution requires owner approval.
//
// Exit status: 0 done, 1 failed, 2 refused (a precondition is missing or the state is dangerous), 64 bad usage.
// Documentation: docs/AWS.md.
import { runCloud } from './commands';
import { realDeps } from './deps';

runCloud(process.argv.slice(2), realDeps()).then((code) => process.exit(code));
