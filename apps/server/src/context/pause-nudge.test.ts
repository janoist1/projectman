import { describe, expect, it } from 'vitest';
import { createContextPackBuilder } from './context-pack';
import { buildPauseNudge } from './continue-message';

describe('pause nudge', () => {
  it('says the work goes on and what happened to the tool it was cut at', () => {
    const after = buildPauseNudge({ point: 'after_tool', tool: 'Bash', restarted: false });
    expect(after).toContain('resumed');
    expect(after).toContain('Bash');
    expect(after).toContain('finished');
    expect(buildPauseNudge({ point: 'before_tool', tool: 'Edit', restarted: false })).toContain(
      'did not run',
    );
    expect(buildPauseNudge({ point: 'interrupted', tool: 'Bash', restarted: false })).toContain(
      'interrupted',
    );
  });

  it('says what a restart lost: the open approval request and the background commands', () => {
    const text = buildPauseNudge({ point: 'waiting_permission', tool: null, restarted: true });
    expect(text).toContain('started again');
    expect(text).toContain('approval request');
    expect(text).toContain('background');
    expect(buildPauseNudge({ point: 'after_tool', tool: null, restarted: false })).not.toContain(
      'background',
    );
  });

  it('is part of the context pack builder', () => {
    const builder = createContextPackBuilder();
    expect(builder.pauseNudge?.({ point: 'after_tool', tool: null, restarted: false })).toBeTruthy();
  });
});
