const BLOCKING: Array<[RegExp, string]> = [
  [/Select login method:/i, 'Gemini is not logged in; run agy and sign in with Google.'],
  [/Do you trust the contents of this project\?/i, 'Gemini workspace trust is waiting in the terminal.'],
  [/Choose your color scheme:|Terms of Service & Data Use/i, 'Gemini onboarding is waiting in the terminal.'],
  [/Run this command\?/i, 'A Gemini approval prompt is waiting in the terminal.'],
  [/Your AI credits balance is too low to continue\./i, 'Gemini AI credits are exhausted.'],
];
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
