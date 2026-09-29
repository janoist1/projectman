/**
 * How a message is typed into Claude Code's prompt box.
 *
 * Claude Code collapses a single paste of more than 800 characters or more than two line
 * breaks into a "[Pasted text #N]" placeholder, and newer versions tell Claude that such
 * pasted content may carry instructions the user did not write. A kick-off brief or a team
 * message must reach Claude as typed text, so each line is sent as its own small bracketed
 * paste (no line breaks inside), and line breaks are sent as Ctrl+J, which inserts a newline
 * in the prompt in every terminal. Enter (CR) submits.
 *
 * Control characters are removed: an ESC inside a message could end the bracketed paste early
 * and inject keystrokes. A leading "!" is prefixed with a space, because pasting "!" into an
 * empty prompt switches Claude Code to shell mode.
 */

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';
/** Ctrl+J: newline inside the prompt. */
export const NEWLINE_KEY = '\n';
/** Enter: submit the prompt. */
export const ENTER_KEY = '\r';
/** Well below Claude Code's 800-character paste threshold. */
export const MAX_PASTE_CHARS = 500;

// C0 controls except TAB (0x09) and LF (0x0a), DEL and C1 controls.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Normalises line breaks, strips control characters and surrounding blank space. */
export function sanitizeMessage(text: string): string {
  const clean = text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();
  return clean.startsWith('!') ? ` ${clean}` : clean;
}

/** Splits `text` into pieces of at most `max` UTF-16 units without breaking surrogate pairs. */
export function splitPieces(text: string, max: number = MAX_PASTE_CHARS): string[] {
  const pieces: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1; // keep the surrogate pair together
    }
    pieces.push(text.slice(i, end));
    i = end;
  }
  return pieces;
}

/**
 * The writes that type `text` into the prompt (without the final Enter). Each element is
 * written separately, with a short pause in between, so the TUI handles them one by one.
 */
export function messageKeystrokes(text: string): string[] {
  const clean = sanitizeMessage(text);
  if (!clean) return [];
  const steps: string[] = [];
  const lines = clean.split('\n');
  lines.forEach((line, index) => {
    for (const piece of splitPieces(line)) steps.push(`${PASTE_START}${piece}${PASTE_END}`);
    if (index < lines.length - 1) steps.push(NEWLINE_KEY);
  });
  return steps;
}
