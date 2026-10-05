import { describe, expect, it } from 'vitest';
import { parseGeminiLogin, checkGeminiLogin } from './login';
import { FAKE_GEMINI, tempDirs } from '../../test-helpers';
describe('Gemini login', () => {
  it('requires a model TSV or an explicit sign-in failure', () => {
    expect(
      parseGeminiLogin({ stdout: 'gemini-model\tName\n', stderr: '', code: 0, error: null }),
    ).toMatchObject({ loggedIn: true, method: 'google' });
    expect(parseGeminiLogin({ stdout: '', stderr: 'Please sign in', code: 1, error: null })).toMatchObject({
      loggedIn: false,
      problem: 'not_logged_in',
    });
    expect(parseGeminiLogin({ stdout: 'unexpected', stderr: '', code: 0, error: null }).loggedIn).toBeNull();
  });
  it('rejects non-consumer logins and missing CLI without touching the real home', async () => {
    const dirs = tempDirs();
    const config = await dirs.make();
    try {
      const env = { PATH: process.env.PATH ?? '', HOME: config };
      expect(await checkGeminiLogin(FAKE_GEMINI, config, env)).toMatchObject({ loggedIn: true });
      expect(
        await checkGeminiLogin(FAKE_GEMINI, config, { ...env, FAKE_GEMINI_AUTH_METHOD: 'vertex' }),
      ).toMatchObject({ loggedIn: false, method: 'vertex' });
      expect(
        await checkGeminiLogin(FAKE_GEMINI, config, { ...env, FAKE_GEMINI_LOGGED_OUT: '1' }),
      ).toMatchObject({ loggedIn: false });
      expect(await checkGeminiLogin('/missing/agy', config, env)).toMatchObject({ problem: 'cli_missing' });
    } finally {
      await dirs.cleanup();
    }
  });
});
