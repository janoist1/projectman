import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  detectGeminiBlockingScreen,
  detectGeminiQuota,
  geminiPromptVisible,
  geminiWorkingVisible,
} from './screen';
const fixture = (name: string) =>
  readFile(new URL(`../../../../test/fixtures/gemini/screens/${name}.txt`, import.meta.url), 'utf8');
describe('Gemini screens', () => {
  it('reads a quota reset longer than a day across wrapped terminal lines', () => {
    expect(
      detectGeminiQuota('RESOURCE_EXHAUSTED (code 429): Individual quota reached.\nResets in 65h10m58s.'),
    ).toMatchObject({
      resetsInMs: (65 * 3600 + 10 * 60 + 58) * 1000,
    });
  });
  it('keeps a quota error without a usable reset time', () => {
    expect(detectGeminiQuota('RESOURCE_EXHAUSTED (code 429): Individual quota reached.')).toEqual({
      message: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached.',
      resetsInMs: null,
    });
  });
  it('ignores unrelated resource and request errors', () => {
    expect(detectGeminiQuota('RESOURCE_EXHAUSTED (code 429): Server overloaded.')).toBeNull();
  });
  it('does not treat a quota error quoted in the input prompt as a provider failure', () => {
    expect(
      detectGeminiQuota('> RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 65h10m58s.'),
    ).toBeNull();
  });
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
