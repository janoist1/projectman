import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));

/** The fake CLIs of the test suite; they never reach Anthropic, OpenAI or GitHub. */
export const FAKE_CLIS = {
  claude: join(repo, 'apps/server/test/fixtures/fake-claude.mjs'),
  codex: join(repo, 'apps/server/test/fixtures/fake-codex.mjs'),
  gh: join(repo, 'apps/server/src/github/test-fixtures/fake-gh.mjs'),
};

/**
 * Environment of a projectman server that runs the fake claude, codex and gh CLIs, with their
 * state under `dir`, so no real CLI account is used:
 *   dir/claude-config     CLAUDE_CONFIG_DIR; its .claude.json trusts the `trusted` folders
 *   dir/codex-home        CODEX_HOME
 *   dir/transcripts       the fake Claude CLI's transcripts
 *   dir/gh-scenario.json  the fake gh's answers: logged in, no pull requests found
 * Test switches of the fake CLIs inherited from the caller's environment are dropped.
 */
export function fakeCliEnv(dir, { trusted = [] } = {}) {
  const claudeConfigDir = join(dir, 'claude-config');
  const claudeConfig = join(claudeConfigDir, '.claude.json');
  const ghScenario = join(dir, 'gh-scenario.json');
  for (const sub of ['claude-config', 'codex-home', 'transcripts'])
    mkdirSync(join(dir, sub), { recursive: true });
  if (!existsSync(claudeConfig)) {
    const projects = Object.fromEntries(trusted.map((path) => [path, { hasTrustDialogAccepted: true }]));
    writeFileSync(claudeConfig, JSON.stringify({ numStartups: 1, projects }), { mode: 0o600 });
  }
  if (!existsSync(ghScenario)) writeFileSync(ghScenario, '{}\n');

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^FAKE_(CLAUDE|CODEX|GH)_/.test(key)) delete env[key];
  }
  return {
    ...env,
    CLAUDE_BIN: FAKE_CLIS.claude,
    CODEX_BIN: FAKE_CLIS.codex,
    GH_BIN: FAKE_CLIS.gh,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CODEX_HOME: join(dir, 'codex-home'),
    FAKE_CLAUDE_CONFIG_FILE: claudeConfig,
    FAKE_CLAUDE_TRANSCRIPT_DIR: join(dir, 'transcripts'),
    FAKE_GH_SCENARIO: ghScenario,
  };
}
