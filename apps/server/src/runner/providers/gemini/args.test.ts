import { describe, expect, it } from 'vitest';
import { buildGeminiArgs } from './args';
import { geminiSpec, CONVERSATION_ID } from './test-helpers';
describe('Gemini arguments', () => {
  it('uses isolated config, disables updates, and types the brief separately', () => {
    const args = buildGeminiArgs(
      geminiSpec('/work', { initialMessage: 'brief', additionalDirectories: ['/read'], resume: true }),
      '/config',
    );
    expect(args).toEqual([
      '--gemini_dir',
      '/config',
      '--log-file',
      '/config/agy.log',
      '--release_base_url',
      'http://127.0.0.1:9',
      '--model',
      'gemini-3.8-flash',
      '--effort',
      'medium',
      '--add-dir',
      '/read',
      '--conversation',
      CONVERSATION_ID,
    ]);
  });
  it.each(['max', 'xhigh'] as const)('maps %s to high', (effort) =>
    expect(buildGeminiArgs(geminiSpec('/work', { effort }), '/config')).toContain('high'),
  );
  it('raises missing family effort and preserves full slugs', () => {
    expect(buildGeminiArgs(geminiSpec('/work', { model: 'gemini-3.1-pro' }), '/config')).toContain('high');
    expect(
      buildGeminiArgs(geminiSpec('/work', { model: 'gemini-3.8-flash-low', effort: 'high' }), '/config'),
    ).not.toContain('--effort');
    expect(
      buildGeminiArgs(geminiSpec('/work', { model: 'gemini-future', permissionMode: 'plan' }), '/config'),
    ).toContain('plan');
  });
  it('refuses missing policy and strict enforcement', () => {
    expect(() => buildGeminiArgs(geminiSpec('/work', { policy: undefined }), '/config')).toThrow('policy');
    const spec = geminiSpec();
    spec.policy!.enforcement = 'strict';
    expect(() => buildGeminiArgs(spec, '/config')).toThrow('Strict');
  });
});
