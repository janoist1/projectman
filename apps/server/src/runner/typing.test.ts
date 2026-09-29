import { describe, expect, it } from 'vitest';
import {
  MAX_PASTE_CHARS,
  NEWLINE_KEY,
  PASTE_END,
  PASTE_START,
  messageKeystrokes,
  sanitizeMessage,
  splitPieces,
} from './typing';

/** Rebuilds the text Claude Code's prompt box would contain after the keystrokes. */
function replay(steps: string[]): string {
  return steps
    .map((step) => (step === NEWLINE_KEY ? '\n' : step.slice(PASTE_START.length, -PASTE_END.length)))
    .join('');
}

describe('messageKeystrokes', () => {
  it('sends a short single-line message as one bracketed paste', () => {
    expect(messageKeystrokes('Hello team')).toEqual([`${PASTE_START}Hello team${PASTE_END}`]);
  });

  it('never puts a line break or more than the paste limit into one paste', () => {
    const text = `# AR-21 Brief\n\n${'long line '.repeat(200)}\n- item 1\n- item 2\n\nEnd`;
    const steps = messageKeystrokes(text);
    for (const step of steps) {
      if (step === NEWLINE_KEY) continue;
      expect(step.startsWith(PASTE_START) && step.endsWith(PASTE_END)).toBe(true);
      const content = step.slice(PASTE_START.length, -PASTE_END.length);
      expect(content).not.toContain('\n');
      expect(content.length).toBeLessThanOrEqual(MAX_PASTE_CHARS);
    }
    expect(replay(steps)).toBe(text);
  });

  it('removes control characters, so a message cannot end the paste or press keys', () => {
    // A lone CR counts as a line break; ESC, ^C, BEL and C1 controls disappear.
    const steps = messageKeystrokes('a\x1b[201~\rb\x03c\x07d\u009be\r\nf\tg');
    expect(replay(steps)).toBe('a[201~\nbcde\nf\tg');
    for (const step of steps) expect(step.slice(PASTE_START.length, -PASTE_END.length)).not.toMatch(/\x1b/);
  });

  it('keeps a leading "!" from switching the prompt to shell mode', () => {
    expect(sanitizeMessage('!important: fix it')).toBe(' !important: fix it');
    expect(sanitizeMessage('  \n text \n')).toBe('text');
  });

  it('types nothing for an empty message', () => {
    expect(messageKeystrokes(' \n\t ')).toEqual([]);
  });
});

describe('splitPieces', () => {
  it('does not split surrogate pairs', () => {
    const text = `${'a'.repeat(4)}🚀${'b'.repeat(4)}`;
    const pieces = splitPieces(text, 5);
    expect(pieces.join('')).toBe(text);
    expect(pieces[0]).toBe('aaaa');
    expect(pieces[1]).toBe('🚀bbb');
  });
});
