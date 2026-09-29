/**
 * Environment for Claude Code child processes.
 *
 * Members run on the owner's Claude subscription, never on API billing, so every variable
 * that would switch Claude Code to an API key, a custom endpoint or a cloud provider is
 * removed. Variables that a parent Claude Code session leaves behind (when projectman
 * itself is started from inside Claude Code) are removed too: they make the child believe
 * it is a nested session, which changes its behaviour (for example transcript saving).
 * The list of host-session markers follows agent-office (MIT, src/server/workers.ts).
 */

/** Variables that would move billing away from the subscription. Never passed on. */
export const BILLING_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

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
]);

/** Prefixes of host-session variables. */
const HOST_SESSION_PREFIXES = [
  'CLAUDE_CODE_SESSION',
  'CLAUDE_CODE_CHILD',
  'CLAUDE_CODE_MESSAGING',
  'PROJECTMAN_',
];

function isRemoved(name: string): boolean {
  if ((BILLING_ENV_VARS as readonly string[]).includes(name)) return true;
  if (HOST_SESSION_VARS.has(name)) return true;
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

/** Environment of an interactive member session. */
export function buildSessionEnv(base: NodeJS.ProcessEnv, sessionId: string): Record<string, string> {
  return withLocalNoProxy(
    buildChildEnv(base, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PROJECTMAN_SESSION_ID: sessionId,
    }),
  );
}
