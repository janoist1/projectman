import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { detectGeminiBlockingScreen, geminiPromptVisible, geminiWorkingVisible } from './screen';
const fixture = (name: string) =>
  readFile(new URL(`../../../../test/fixtures/gemini/screens/${name}.txt`, import.meta.url), 'utf8');
describe('Gemini screens', () => {
  it.each(['turn-done', 'ready-after-trust', 'ready-with-announcement-banner', 'resumed-conversation'])(
    'recognizes %s',
    async (name) => expect(geminiPromptVisible(await fixture(name))).toBe(true),
  );
  it('does not treat an incomplete paste frame as ready', async () =>
    expect(geminiPromptVisible(await fixture('prompt-multiline-paste'))).toBe(false));
  it.each([
    'login-method',
    'trust-folder',
    'onboarding-color-scheme',
    'onboarding-terms',
    'permission-ask-plain',
    'permission-ask-with-hook-reason',
  ])('detects %s', async (name) => expect(detectGeminiBlockingScreen(await fixture(name))).not.toBeNull());
  it('ignores transient sign-in text and recognizes generation', async () => {
    expect(detectGeminiBlockingScreen(await fixture('ready'))).toBeNull();
    expect(geminiWorkingVisible(await fixture('working-generating'))).toBe(true);
  });
});
