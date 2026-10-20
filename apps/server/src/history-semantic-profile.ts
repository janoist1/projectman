import { createProfileControl, PROFILE_SECRET_MIN_LENGTH } from './history-semantic-profile-control';
import { main, reportStartFailure } from './start';

// The measurement entry of the history search's local embedding (PM-910, docs/HYBRID.md "History semantic profile"):
// the same server as index.ts, started the same way, plus one loopback listener for the search facade. Built as
// dist/history-semantic-profile.js; index.ts never loads it, and only deploy/cloud/history-semantic-profile.mjs starts it.
//   PROJECTMAN_HISTORY_PROFILE_PORT    the loopback port of the search listener
//   PROJECTMAN_HISTORY_PROFILE_SECRET  the one-time secret of the measurement run (read once, then removed)
const port = Number(process.env.PROJECTMAN_HISTORY_PROFILE_PORT);
const secret = process.env.PROJECTMAN_HISTORY_PROFILE_SECRET ?? '';
delete process.env.PROJECTMAN_HISTORY_PROFILE_SECRET;

main({
  afterStart: ({ app }) => {
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error('invalid PROJECTMAN_HISTORY_PROFILE_PORT');
    if (secret.length < PROFILE_SECRET_MIN_LENGTH)
      throw new Error('invalid PROJECTMAN_HISTORY_PROFILE_SECRET');
    const control = createProfileControl({ secret, facade: app.projectman.domain.history });
    // The listener ends with the process: the shutdown of start.ts exits it.
    control.unref();
    return new Promise<void>((resolve, reject) => {
      control.once('error', reject);
      control.listen(port, '127.0.0.1', () => resolve());
    });
  },
}).catch(reportStartFailure);
