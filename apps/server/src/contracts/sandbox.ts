import path from 'node:path';
import { CONTROL_SOCKET_NAME } from '@projectman/shared';

/** Where `hybrid back` (PM-318) moves the Mac's former entries, in a dated folder per run. */
export const HYBRID_ARCHIVE_DIR = 'pre-hybrid';
/** Where `hybrid back` stages the downloaded cloud data inside the home, in a random folder per run. */
export const HYBRID_STAGING_DIR = '.hybrid-back';

/**
 * The folder below the app home where the runner keeps each session's private launch files (PM-156):
 * the CLI's settings, its MCP configuration and the hook forwarder's target, which hold the session's
 * tokens. The whole folder is closed to the sessions' commands and file tools.
 */
export const SESSION_CONFIG_DIR = 'run';

/** The network rule of a member whose outbound network is on (PM-355): every host except the denied ones. */
export const OPEN_OUTBOUND_DOMAINS = ['*'];

/**
 * Environment variables a developer's sandboxed commands never see (PM-153): publishing tokens and
 * the SSH agent, with which a command could push or sign in elsewhere.
 */
export const SANDBOX_DENIED_ENV_VARS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'SSH_AUTH_SOCK',
];

/**
 * Commands a reader runs outside its sandbox, through the usual permission rules (its allow list
 * pre-approves them): they need the GitHub CLI's login, which the sandbox does not let it read.
 * Only for a repository on GitHub, each only as a command of its own (PM-188).
 */
export const READER_UNSANDBOXED_COMMANDS = ['gh pr view', 'gh pr diff'];

/**
 * What the built-in file tools never read or change, whatever the permission mode (PM-165): the
 * credentials of the user (`userHome`) and the sensitive parts of the live instance (`appHome`:
 * the database, the cookie secret, the logs, the customization repository, the members' memory,
 * the publishing identity and the spool). Not the whole app home: the members' worktrees,
 * workspaces and the task attachments live there, and a deny rule wins over an allow rule.
 */
export function sensitivePaths(input: { userHome: string; appHome?: string }): string[] {
  // The folders `hybrid back` makes inside the home (PM-318) hold copies of the old database, the cookie key,
  // the secrets and the machine key: fixed names, so that a plain path denies the whole tree.
  // Not the whole `.claude`: the member's own saved tool outputs (`projects/.../tool-results`) and the
  // plan file of the plan mode (`plans`) live there. Only the credentials and the settings.
  const user = [
    '.ssh',
    '.config/gh',
    '.config/projectman',
    '.claude/.credentials.json',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/hooks',
    '.claude.json',
    '.codex',
    '.gemini',
    '.npmrc',
    // The owner's cloud logins (PM-533): the AWS CLI's keys and SSO/CLI caches, the Cloudflare tunnel
    // certificate and Access tokens. Whole directories.
    '.aws',
    '.cloudflared',
  ];
  // `logs` is not created by the server itself: the owner's live home has it (the process logs of
  // `npm start`). A name that does not exist denies nothing.
  const app = [
    'db.sqlite*',
    'secret',
    // The secret store and the providers' own CLI homes (PM-324): the NanoGPT key, the NanoGPT Codex home.
    'secrets',
    'providers',
    'logs',
    'customization',
    'memory',
    // Private Operator agreements, principles and preferences (PM-687).
    'operator-data',
    // Message files follow recipient visibility; authorized copies go to session folders (PM-524).
    'message-attachments',
    'github-publish',
    'spool',
    // The private launch files of the running sessions: their tokens (PM-156).
    SESSION_CONFIG_DIR,
    // The release watcher's journal, lock and database backups (PM-493): the backups hold all data.
    'release',
    // The administration supervisor's state, journal and socket on a machine that has the app home (PM-763).
    'administration',
    HYBRID_ARCHIVE_DIR,
    HYBRID_STAGING_DIR,
    CONTROL_SOCKET_NAME,
  ];
  return [
    ...user.map((name) => path.join(input.userHome, name)),
    ...(input.appHome ? app.map((name) => path.join(input.appHome!, name)) : []),
  ];
}
