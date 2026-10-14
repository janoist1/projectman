import { DomainError } from '../../domain/errors';

/** The lines of a text: none for an empty one; the line break that ends the last line does not start another. */
export function docLines(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/**
 * The text after the edits, applied in order. An empty `old_text` appends `new_text` at the end of the
 * file (after a line break, when the text is not empty and does not end with one); any other `old_text`
 * must occur exactly once and is replaced by `new_text`.
 */
export function applyDocEdits(text: string, edits: { old_text: string; new_text: string }[]): string {
  let result = text;
  edits.forEach((edit, index) => {
    if (edit.old_text === '') {
      result = `${result}${result !== '' && !result.endsWith('\n') ? '\n' : ''}${edit.new_text}`;
      return;
    }
    const first = result.indexOf(edit.old_text);
    if (first < 0)
      throw new DomainError(
        'docs_edit_not_found',
        `edit ${index + 1}: old_text is not in the file; read the file again and copy the text exactly`,
        { status: 422, details: { edit: index + 1 } },
      );
    if (result.indexOf(edit.old_text, first + 1) >= 0)
      throw new DomainError(
        'docs_edit_ambiguous',
        `edit ${index + 1}: old_text occurs more than once; include more of the surrounding text`,
        { status: 422, details: { edit: index + 1 } },
      );
    result = result.slice(0, first) + edit.new_text + result.slice(first + edit.old_text.length);
  });
  return result;
}

/**
 * Whether every line of `before` is in `after`, unchanged and in the same order (as a subsequence): lines
 * may be added anywhere, none may change or go.
 */
export function isAppendOnly(before: string, after: string): boolean {
  const kept = docLines(after);
  let next = 0;
  for (const line of docLines(before)) {
    while (next < kept.length && kept[next] !== line) next++;
    if (next === kept.length) return false;
    next++;
  }
  return true;
}
