import { describe, expect, it } from 'vitest';
import { applyDocEdits, docLines, isAppendOnly } from './doc-edits';
import { DomainError } from '../../domain/errors';

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (err) {
    return err instanceof DomainError ? err.code : 'other';
  }
  return undefined;
}

describe('docLines', () => {
  it('has no lines for an empty text, and ignores the break that ends the last one', () => {
    expect(docLines('')).toEqual([]);
    expect(docLines('a\nb')).toEqual(['a', 'b']);
    expect(docLines('a\nb\n')).toEqual(['a', 'b']);
    expect(docLines('a\n\n')).toEqual(['a', '']);
  });
});

describe('applyDocEdits', () => {
  it('replaces the one place old_text is at', () => {
    expect(applyDocEdits('a\nb\nc\n', [{ old_text: 'b', new_text: 'B' }])).toBe('a\nB\nc\n');
  });

  it('appends on an empty old_text, with a line break when the text lacks one', () => {
    expect(applyDocEdits('a\n', [{ old_text: '', new_text: 'b\n' }])).toBe('a\nb\n');
    expect(applyDocEdits('a', [{ old_text: '', new_text: 'b' }])).toBe('a\nb');
    expect(applyDocEdits('', [{ old_text: '', new_text: 'b' }])).toBe('b');
  });

  it('applies the edits in order, each to the result of the one before', () => {
    expect(
      applyDocEdits('a\n', [
        { old_text: '', new_text: 'b' },
        { old_text: 'b', new_text: 'c' },
      ]),
    ).toBe('a\nc');
  });

  it('refuses an old_text that is not in the file', () => {
    expect(codeOf(() => applyDocEdits('a\n', [{ old_text: 'x', new_text: 'y' }]))).toBe(
      'docs_edit_not_found',
    );
  });

  it('refuses an old_text that occurs twice', () => {
    expect(codeOf(() => applyDocEdits('a\na\n', [{ old_text: 'a', new_text: 'y' }]))).toBe(
      'docs_edit_ambiguous',
    );
  });

  it('names the edit that failed', () => {
    try {
      applyDocEdits('a\n', [
        { old_text: '', new_text: 'b' },
        { old_text: 'x', new_text: 'y' },
      ]);
      expect.unreachable();
    } catch (err) {
      expect((err as DomainError).details).toEqual({ edit: 2 });
      expect((err as DomainError).status).toBe(422);
    }
  });
});

describe('isAppendOnly', () => {
  const log = '1. First\n2. Second\n';

  it('accepts lines added at the end or in the middle', () => {
    expect(isAppendOnly(log, `${log}3. Third\n`)).toBe(true);
    expect(isAppendOnly(log, '1. First\nnote\n2. Second\n')).toBe(true);
    expect(isAppendOnly(log, `0. Zero\n${log}`)).toBe(true);
  });

  it('accepts a text with no change, and any text after an empty one', () => {
    expect(isAppendOnly(log, log)).toBe(true);
    expect(isAppendOnly('', 'a\n')).toBe(true);
  });

  it('refuses a changed line', () => {
    expect(isAppendOnly(log, '1. First\n2. Changed\n')).toBe(false);
  });

  it('refuses a removed line', () => {
    expect(isAppendOnly(log, '2. Second\n')).toBe(false);
    expect(isAppendOnly(log, '')).toBe(false);
  });

  it('refuses lines that changed their order', () => {
    expect(isAppendOnly(log, '2. Second\n1. First\n')).toBe(false);
  });

  it('is not fooled by a line break at the end', () => {
    expect(isAppendOnly('a\nb', 'a\nb\n')).toBe(true);
    expect(isAppendOnly('a\nb\n', 'a\nb')).toBe(true);
  });
});
