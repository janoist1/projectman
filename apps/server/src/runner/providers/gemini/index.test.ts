import { describe, expect, it } from 'vitest';
import { createGeminiAdapter } from './index';
import { silentLogger } from '../../test-helpers';
import { geminiSpec } from './test-helpers';
describe('Gemini adapter', () => {
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
    expect(await adapter.planUsage.get()).toBeNull();
  });
});
