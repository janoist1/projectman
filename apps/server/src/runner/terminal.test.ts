import { expect, test } from 'vitest';
import { HeadlessScreen } from './terminal';

test('constructs synchronously and restores text and terminal modes from a snapshot', async () => {
  const screen = new HeadlessScreen(40, 6);
  const restored = new HeadlessScreen(40, 6);
  try {
    screen.write('first line\r\n\x1b[32msecond line\x1b[0m\x1b[?2004h\x1b[?1000h\x1b[?1006h');
    await screen.flush();
    expect(screen.screenText()).toContain('first line\nsecond line');
    expect(screen.bracketedPasteMode).toBe(true);
    const snapshot = screen.snapshot();
    expect(snapshot).toContain('\x1b[?1006h');
    restored.write(snapshot);
    await restored.flush();
    expect(restored.screenText()).toBe(screen.screenText());
    expect(restored.bracketedPasteMode).toBe(true);
    restored.resize(60, 8);
    expect([restored.cols, restored.rows]).toEqual([60, 8]);
  } finally {
    screen.dispose();
    restored.dispose();
  }
});
