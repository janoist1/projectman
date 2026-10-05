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

/** Variables that would move billing away from the subscription. Never passed on. */
export const BILLING_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  // Codex: CODEX_API_KEY overrides the ChatGPT login; voice falls back to OPENAI_API_KEY.
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_AD_TOKEN',
  // Gemini (Antigravity CLI): API keys, custom endpoints and the Vertex / enterprise / pay-as-you-go
  // routes bill something other than the Google subscription.
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_ENTERPRISE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'AGY_ADC_AUTH',
  'AGY_BUSINESS_PAYGO_TIER',
  // NanoGPT: only the NanoGPT adapter hands the key back, as a trusted `extra`, to NanoGPT members.
  'NANOGPT_API_KEY',
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

/**
 * What a managed VM worker (PM-141) never inherits from the service's environment: a way to act
 * as someone else on the network. The VM has no agent socket and the worker's GitHub identity is
 * its own (PM-142), so none of the service's reaches it, whatever the unit's environment holds.
 */
const MANAGED_VM_REMOVED_VARS = new Set([
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'SSH_ASKPASS',
  'GIT_ASKPASS',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
]);

/** Environment of an interactive member session. */
export function buildSessionEnv(
  base: NodeJS.ProcessEnv,
  sessionId: string,
  opts: { managedVm?: boolean; instanceTag?: string } = {},
): Record<string, string> {
  const env = withLocalNoProxy(
    buildChildEnv(base, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PROJECTMAN_SESSION_ID: sessionId,
      // With the session id it marks every process of the session as this instance's (PM-320).
      ...(opts.instanceTag ? { PROJECTMAN_INSTANCE: opts.instanceTag } : {}),
    }),
  );
  if (opts.managedVm) for (const name of MANAGED_VM_REMOVED_VARS) delete env[name];
  return env;
}
