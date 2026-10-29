import { runLive } from './commands';
import { realDeps } from './deps';

runLive(process.argv.slice(2), realDeps).then((code) => process.exit(code));
