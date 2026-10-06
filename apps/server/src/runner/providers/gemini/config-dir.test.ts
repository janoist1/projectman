import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDirs } from '../../test-helpers';
import { prepareGeminiDir } from './config-dir';
import { geminiSpec, CONVERSATION_ID } from './test-helpers';
const dirs = tempDirs();
afterEach(() => dirs.cleanup());
describe('Gemini conversation directory', () => {
  it('writes private configuration and reuses the original directory on resume', async () => {
    const cwd = await dirs.make();
    const config = await dirs.make();
    const input = {
      spec: geminiSpec(cwd),
      hookUrl: 'http://127.0.0.1:4700/hooks/new',
      permissionTimeoutMs: 600000,
    };
    const dir = await prepareGeminiDir(config, input);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    for (const file of [
      'config/hooks.json',
      'config/mcp_config.json',
      'antigravity-cli/settings.json',
      'antigravity-cli/cache/onboarding.json',
    ])
      expect((await stat(path.join(dir, file))).mode & 0o777).toBe(0o600);
    const hooks = JSON.parse(await readFile(path.join(dir, 'config/hooks.json'), 'utf8')).projectman;
    expect(hooks.PreToolUse[0].hooks[0]).toMatchObject({ timeout: 630 });
    expect(hooks.PreToolUse[0].hooks[0].command).toContain('/PreToolUse');
    expect(hooks.PreToolUse[0].hooks[0].command).toContain('blocked');
    expect(
      JSON.parse(await readFile(path.join(dir, 'config/mcp_config.json'), 'utf8')).mcpServers.team.url,
    ).toBe(input.spec.mcpUrl);
    await mkdir(path.join(dir, 'antigravity-cli/brain', CONVERSATION_ID), { recursive: true });
    await writeFile(path.join(dir, 'antigravity-cli/settings.json'), JSON.stringify({ kept: true }));
    expect(
      await prepareGeminiDir(config, {
        ...input,
        spec: { ...input.spec, sessionId: 'ses_resume', resume: true },
      }),
    ).toBe(dir);
    expect(JSON.parse(await readFile(path.join(dir, 'antigravity-cli/settings.json'), 'utf8'))).toMatchObject(
      { kept: true, toolPermission: 'always-proceed', trustedWorkspaces: [cwd] },
    );
  });
  it('refuses path traversal, missing resume, and workspace hooks in parents or additional directories', async () => {
    const root = await dirs.make();
    const cwd = path.join(root, 'work');
    await mkdir(cwd);
    const config = await dirs.make();
    const input = { spec: geminiSpec(cwd), hookUrl: 'http://127.0.0.1:1/hooks/x', permissionTimeoutMs: 1000 };
    await expect(prepareGeminiDir(undefined, input)).rejects.toThrow('required');
    await expect(
      prepareGeminiDir(config, { ...input, spec: { ...input.spec, sessionId: '..' } }),
    ).rejects.toThrow('Invalid');
    await expect(
      prepareGeminiDir(config, { ...input, spec: { ...input.spec, resume: true } }),
    ).rejects.toThrow('not found');
    await mkdir(path.join(root, '.agents'));
    await writeFile(path.join(root, '.agents/hooks.json'), '{}');
    await expect(prepareGeminiDir(config, input)).rejects.toThrow('.agents');
    const clean = await dirs.make();
    await expect(
      prepareGeminiDir(config, { ...input, spec: geminiSpec(clean, { additionalDirectories: [root] }) }),
    ).rejects.toThrow('.agents');
  });
});
