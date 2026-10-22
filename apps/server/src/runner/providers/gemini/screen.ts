const BLOCKING: Array<[RegExp, string]> = [
  [/Select login method:/i, 'Gemini is not logged in; run agy and sign in with Google.'],
  [/Do you trust the contents of this project\?/i, 'Gemini workspace trust is waiting in the terminal.'],
  [/Choose your color scheme:|Terms of Service & Data Use/i, 'Gemini onboarding is waiting in the terminal.'],
  [/Run this command\?/i, 'A Gemini approval prompt is waiting in the terminal.'],
  [/Your AI credits balance is too low to continue\./i, 'Gemini AI credits are exhausted.'],
];

/** A quota error displayed by agy, including its relative reset time when supplied. */
export function detectGeminiQuota(text: string): { message: string; resetsInMs: number | null } | null {
  const error = [
    ...text.matchAll(/^(?![ \t]*>)(?=[^\n]*\bRESOURCE_EXHAUSTED\b)(?=[^\n]*\b429\b)[^\n]+/gim),
  ].at(-1);
  if (!error) return null;
  const message = text.slice(error.index).trim();
  const reset = /Resets\s+in\s+(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?/i.exec(message);
  const seconds = reset
    ? Number(reset[1] ?? 0) * 3600 + Number(reset[2] ?? 0) * 60 + Number(reset[3] ?? 0)
    : 0;
  // A transient request-level 429 may be retried by agy itself. Only a quota message
  // or an explicit reset duration parks the provider and releases its cards.
  if (!/Individual\s+quota/i.test(message) && seconds <= 0) return null;
  return {
    message,
    resetsInMs: seconds > 0 && Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : null,
  };
}
export function detectGeminiBlockingScreen(text: string): string | null {
  // Captures may include older dialogs above the current composer.
  const composer =
    /^\s*─{10,}[^\n]*\n\s*>[^\n]*\n(?:[^\n]*\n){0,20}?\s*─{10,}[^\n]*\n[^\n]*(?:\? for shortcuts|esc to cancel)/im.exec(
      text,
    );
  if (composer) text = text.slice(composer.index + composer[0].length);
  return BLOCKING.find(([re]) => re.test(text))?.[1] ?? null;
}
export function geminiPromptVisible(text: string): boolean {
  if (detectGeminiBlockingScreen(text)) return false;
  return /^\s*─{10,}[^\n]*\n\s*>[^\n]*\n(?:[^\n]*\n){0,20}?\s*─{10,}[^\n]*\n[^\n]*(?:\? for shortcuts|esc to cancel)/im.test(
    text,
  );
}
export function geminiWorkingVisible(text: string): boolean {
  return /esc to cancel|Generating\.\.\./i.test(text);
}
