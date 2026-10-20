/**
 * Environment for agent CLI child processes (Claude Code, Codex).
 *
 * Members run on the owner's subscription, never on API billing, so every variable that
 * would switch Claude Code or Codex to an API key, a custom endpoint or a cloud provider is
 * removed. The list is the same for every provider: a member of one provider could start the
 * other provider's CLI from its shell, and that must not reach API billing either.
 * Variables that a parent Claude Code or Codex session leaves behind (when projectman itself
 * is started from inside one) are removed too: they make the child believe it is a nested
 * session, which changes its behaviour (for example transcript saving). The list of
 * host-session markers follows agent-office (MIT, src/server/workers.ts).
 */

import { BILLING_ENV_VARS } from '@projectman/shared';
export { BILLING_ENV_VARS } from '@projectman/shared';

/** Exact names set by a parent Claude Code / Agent SDK session, or that change the TUI. */
const HOST_SESSION_VARS = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'NO_COLOR',
  'FORCE_COLOR',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'VSCODE_INJECTION',
  // Set by a parent Codex session.
  'CODEX_THREAD_ID',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  // Set by a parent Gemini CLI session.
  'GEMINI_CLI',
]);

/** Prefixes of host-session variables. */
const HOST_SESSION_PREFIXES = [
  'CLAUDE_CODE_SESSION',
  'CLAUDE_CODE_CHILD',
  'CLAUDE_CODE_MESSAGING',
  'ANTIGRAVITY_',
  'PROJECTMAN_',
];

/**
 * Cloudflare Access service-token variables (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`) and the names a
 * header-environment convention could give them: the integrator's second credential (PM-765). Matched without
 * regard to case, with `-` read as `_`, so `CF-Access-Client-Secret` and `cf_access_client_secret` go too.
 */
const ACCESS_ENV_PREFIXES = ['CF_ACCESS_', 'CLOUDFLARE_ACCESS_'];

function isAccessCredentialName(name: string): boolean {
  const normal = name.toUpperCase().replace(/-/g, '_');
  return ACCESS_ENV_PREFIXES.some((prefix) => normal.startsWith(prefix));
}

function isRemoved(name: string): boolean {
  if ((BILLING_ENV_VARS as readonly string[]).includes(name)) return true;
  if (HOST_SESSION_VARS.has(name)) return true;
  if (isAccessCredentialName(name)) return true;
  return HOST_SESSION_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Copies `base` without billing and host-session variables, then applies `extra`.
 * Values in `extra` are trusted (set by the runner itself).
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || isRemoved(name)) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

/** Hosts that must never go through an HTTP(S) proxy: hooks and the team MCP server live there. */
export const LOCAL_NO_PROXY = ['127.0.0.1', 'localhost', '::1'] as const;

/**
 * Adds the loopback hosts to NO_PROXY and no_proxy, keeping existing entries. Claude Code
 * (and curl in the SessionStart forwarder) would otherwise send requests to 127.0.0.1 through
 * a configured proxy, leaking the per-session token and breaking hooks and team tools.
 */
export function withLocalNoProxy(env: Record<string, string>): Record<string, string> {
  const out = { ...env };
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const entries = (out[key] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    for (const host of LOCAL_NO_PROXY) if (!entries.includes(host)) entries.push(host);
    out[key] = entries.join(',');
  }
  return out;
}

/**
 * Editors that never open a window: git (a rebase's commit message or todo list) and other tools
 * that start `$EDITOR` would otherwise leave Vim waiting on a terminal nobody types into, and the
 * member could not stop it (PM-428). `true` accepts the file as it is. Set last, for every
 * provider, so neither the service's environment nor a parent session can bring an editor back.
 */
export const NON_INTERACTIVE_EDITOR_ENV = {
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  EDITOR: 'true',
  VISUAL: 'true',
} as const;

/** Environment of an interactive member session. */
export function buildSessionEnv(
  base: NodeJS.ProcessEnv,
  sessionId: string,
  opts: { instanceTag?: string; scopeId?: string } = {},
): Record<string, string> {
  const env = withLocalNoProxy(
    buildChildEnv(base, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...NON_INTERACTIVE_EDITOR_ENV,
      PROJECTMAN_SESSION_ID: sessionId,
      ...(opts.scopeId ? { PROJECTMAN_SCOPE_ID: opts.scopeId } : {}),
      // With the session id it marks every process of the session as this instance's (PM-320).
      ...(opts.instanceTag ? { PROJECTMAN_INSTANCE: opts.instanceTag } : {}),
    }),
  );
  return env;
}
