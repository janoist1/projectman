// The live instance under launchd and the watcher that deploys approved releases (PM-493).
//
//   npm run live -- install [--root <dir>] [--home <dir>] [--port 4800] [--target PM/projectman] [--remote <url>]
//   npm run live -- uninstall | status
//   npm run live -- watch --root <dir> --home <dir> --port <port> --remote <url>   (launchd runs this)
//   npm run live -- config-check --home <dir>
//   npm run release-test
//
// Exit status: 0 done, 1 failed, 2 refused (docs/DEPLOY.md, "The release watcher").
// The watcher renames its own checkout while it runs: scripts/live uses static imports only.
import { runLive } from './commands';
import { realDeps } from './deps';

runLive(process.argv.slice(2), realDeps).then((code) => process.exit(code));
