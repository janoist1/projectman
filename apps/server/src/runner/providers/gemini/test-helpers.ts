import type { StartSessionSpec } from '../../../contracts';
import { buildSessionPolicy } from '../../../../test/helpers/session-policy';
import { testConfig } from '../../../../test/helpers/test-template';
export const CONVERSATION_ID = '05d4a6ce-ca76-4cf2-8487-9d94557688ae';
export function geminiSpec(cwd = '/work', extra: Partial<StartSessionSpec> = {}): StartSessionSpec {
  return {
    sessionId: 'ses_gemini',
    claudeSessionId: CONVERSATION_ID,
    resume: false,
    cwd,
    displayName: 'Gemini',
    appendSystemPrompt: 'Member instructions',
    mcpUrl: 'http://127.0.0.1:4700/mcp/token',
    allowedTools: [],
    provider: 'gemini',
    permissionMode: 'acceptEdits',
    model: 'gemini-3.8-flash',
    policy: buildSessionPolicy({
      config: testConfig(),
      role: 'developer',
      task: { repo: 'web' },
      permissionMode: 'acceptEdits',
      placement: { kind: 'task_worktree', path: cwd },
    }),
    ...extra,
  };
}
