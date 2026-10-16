import { describe, expect, it } from 'vitest';
import { needsDependencies, patchSummary, toolActivity, toolSummary } from './tools';

describe('needsDependencies (PM-743)', () => {
  it('is false for tools that never run project code', () => {
    for (const name of [
      'Read',
      'Edit',
      'MultiEdit',
      'Write',
      'NotebookEdit',
      'NotebookRead',
      'Grep',
      'Glob',
      'TodoWrite',
      'ToolSearch',
      'WebFetch',
      'WebSearch',
      'mcp__team__send_message',
    ])
      expect(needsDependencies(name), name).toBe(false);
  });

  it('is true for the shell, other tools and anything unknown', () => {
    for (const name of ['Bash', 'PowerShell', 'apply_patch', 'Task', 'mcp__other__run', 'something_new'])
      expect(needsDependencies(name), name).toBe(true);
  });
});

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

describe('subagent summaries (PM-179)', () => {
  it('name the subagent, the model the call asks for and the description', () => {
    const call = { subagent_type: 'reader-haiku', description: 'Summarize the test output', prompt: 'x' };
    expect(toolSummary('Agent', call)).toBe('reader-haiku · Summarize the test output');
    expect(toolActivity('Agent', call)).toBe('Agent: reader-haiku · Summarize the test output');
    expect(toolSummary('Task', { ...call, subagent_type: 'Explore', model: 'sonnet' })).toBe(
      'Explore (sonnet) · Summarize the test output',
    );
    expect(toolSummary('Agent', { description: 'Find the callers' })).toBe('Find the callers');
    expect(toolSummary('Agent', { subagent_type: 'reader-sonnet' })).toBe('reader-sonnet');
    expect(toolSummary('Agent', {})).toBe('Agent');
  });
});
