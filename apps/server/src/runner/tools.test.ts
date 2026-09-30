import { describe, expect, it } from 'vitest';
import { patchSummary, toolActivity, toolSummary } from './tools';

const patch = '*** Begin Patch\n*** Update File: /work/src/app.ts\n@@\n-a\n+b\n*** End Patch';

describe('apply_patch summaries', () => {
  it('name the first file a patch touches, relative to the working directory', () => {
    expect(patchSummary(patch)).toBe('/work/src/app.ts');
    expect(patchSummary('*** Delete File: old.txt')).toBe('old.txt');
    expect(patchSummary('no patch here')).toBeNull();
    expect(toolSummary('apply_patch', { command: patch }, '/work')).toBe('src/app.ts');
    expect(toolSummary('apply_patch', { input: patch }, null)).toBe('/work/src/app.ts');
    expect(toolSummary('apply_patch', { input: 'garbage' }, '/work')).toBe('apply_patch');
    expect(toolActivity('apply_patch', { patch }, '/work')).toBe('apply_patch: src/app.ts');
  });
});
