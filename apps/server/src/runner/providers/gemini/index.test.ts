import { afterEach, describe, expect, it } from 'vitest';
import { createGeminiAdapter } from './index';
import { silentLogger, tempDirs } from '../../test-helpers';
import { geminiSpec } from './test-helpers';
const dirs = tempDirs();
afterEach(() => dirs.cleanup());
describe('Gemini adapter', () => {
  it('names the session folder in the environment of the process (PM-522)', async () => {
    const adapter = createGeminiAdapter({
      bin: 'unused',
      configDir: await dirs.make(),
      logger: silentLogger(),
    });
    const spec = geminiSpec(await dirs.make());
    let n = 0;
    const launch = async (policy: typeof spec.policy) =>
      adapter.launch({
        spec: { ...spec, policy, sessionId: `ses_gemini_${n++}` },
        hookUrl: 'http://127.0.0.1:4700/hooks/new',
        sessionConfigDir: await dirs.make(),
        permissionTimeoutMs: 600000,
      });
    const folder = '/instance/folders/ses_gemini.0123456789abcdef';
    const withFolder = {
      ...spec.policy!,
      filesystem: { ...spec.policy!.filesystem, sessionFolder: folder },
    };
    expect((await launch(withFolder)).env).toEqual({ PROJECTMAN_SESSION_DIR: folder });
    expect((await launch(spec.policy)).env).toBeUndefined();
  });

  it('fails closed and injects member instructions on invocation only', async () => {
    const adapter = createGeminiAdapter({ bin: 'unused', logger: silentLogger() });
    expect(adapter.capabilities.toolGate).toBe('pre_tool_use');
    // The CLI has no place for an image in an MCP tool result (PM-518).
    expect(adapter.capabilities.mcpImageResults).toBe(false);
    expect(adapter.turnStartOutput!(geminiSpec())).toEqual({
      injectSteps: [{ ephemeralMessage: 'Member instructions' }],
    });
    expect(adapter.permissionOutput({ behavior: 'allow' }, { hook_event_name: 'PreToolUse' })).toEqual({
      decision: 'allow',
    });
    expect(adapter.haltOutput!('pause')).toEqual({ decision: 'deny', reason: 'pause' });
    expect(adapter.refuseToolOutput!('wait')).toEqual({ decision: 'deny', reason: 'wait' });
    expect(await adapter.planUsage.get()).toBeNull();
  });
});
