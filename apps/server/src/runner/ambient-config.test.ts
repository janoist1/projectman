import { link, mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentProvider } from '@projectman/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectAmbientConfig,
  parseCliVersion,
  CODEX_OVERRIDING_ROOTS,
  CODEX_SANDBOX_ROOTS,
  CODEX_START_ROOTS,
  inspectCodexSandboxConfig,
  inspectCodexMcpServers,
  inspectProjectCodex,
  assertCodexMemberWorkspace,
} from './ambient-config';
import { tempDirs } from './test-helpers';

const dirs = tempDirs();
describe('project Codex allowlist (PM-357)', () => {
  afterEach(() => dirs.cleanup());
  it('accepts missing and empty folders, empty files and model settings with comments', async () => {
    const cwd = await dirs.make();
    const inspect = () => inspectProjectCodex({ cwd, rule: 'member' });
    expect(await inspect()).toEqual([]);
    await mkdir(path.join(cwd, '.codex'));
    expect(await inspect()).toEqual([]);
    const config = path.join(cwd, '.codex/config.toml');
    await writeFile(config, '');
    expect(await inspect()).toEqual([]);
    await writeFile(config, '# model settings\nmodel = "x" # comment\nmodel_reasoning_effort = "high"');
    expect(await inspect()).toEqual([]);
  });
  it.each([
    ['[hooks.Stop]', 'hooks'],
    ['[[hooks.PreToolUse]]', 'hooks'],
    ['[mcp_servers.x]', 'mcp_servers'],
    ['mcp_servers.x.command = "private-value"', 'mcp_servers'],
    ['sandbox_workspace_write.writable_roots = ["private-value"]', 'sandbox_workspace_write'],
    ['["h\\u006foks".Stop]', '"h\\u006foks"'],
    ['future_capability = "private-value"', 'future_capability'],
  ])('refuses %s with key names only', async (text, key) => {
    const cwd = await dirs.make();
    await mkdir(path.join(cwd, '.codex'));
    const file = path.join(cwd, '.codex/config.toml');
    await writeFile(file, text);
    const issues = await inspectProjectCodex({ cwd, rule: 'member' });
    expect(issues).toEqual([{ file, keys: [key] }]);
    expect(JSON.stringify(issues)).not.toContain('private-value');
    const refusal = assertCodexMemberWorkspace(cwd);
    await expect(refusal).rejects.toMatchObject({
      code: 'workspace_codex_config',
      details: { provider: 'codex', issues },
    });
    await expect(refusal).rejects.not.toThrow('private-value');
  });
  it.each(['hooks.json', 'rules', 'agents', 'skills'])('refuses the %s entry', async (entry) => {
    const cwd = await dirs.make();
    await mkdir(path.join(cwd, '.codex'));
    const file = path.join(cwd, '.codex', entry);
    if (entry === 'hooks.json') await writeFile(file, '{}');
    else {
      await mkdir(file);
      if (entry !== 'skills')
        await writeFile(path.join(file, entry === 'rules' ? 'default.rules' : 'x.toml'), '');
    }
    expect(await inspectProjectCodex({ cwd, rule: 'member' })).toEqual([{ file, keys: ['(not allowed)'] }]);
  });
  it.each(['folder', 'nonfolder', 'file', 'hardlink', 'directory'])(
    'refuses a %s in the configuration path',
    async (kind) => {
      const cwd = await dirs.make();
      const other = await dirs.make();
      const folder = path.join(cwd, '.codex');
      const file = path.join(folder, 'config.toml');
      if (kind === 'folder') await symlink(other, folder);
      else if (kind === 'nonfolder') await writeFile(folder, '');
      else {
        await mkdir(folder);
        const target = path.join(other, 'config.toml');
        await writeFile(target, 'model = "x"');
        if (kind === 'file') await symlink(target, file);
        else if (kind === 'hardlink') await link(target, file);
        else await mkdir(file);
      }
      expect(await inspectProjectCodex({ cwd, rule: 'member' })).toEqual([
        {
          file: ['folder', 'nonfolder'].includes(kind) ? folder : file,
          keys: [['folder', 'nonfolder'].includes(kind) ? '(project codex folder)' : '(unreadable)'],
        },
      ]);
    },
  );
  it.each(['file', 'directory'])(
    'walks to the closest %s git root, excluding higher layers',
    async (kind) => {
      const base = await dirs.make();
      const root = path.join(base, 'repo');
      const middle = path.join(root, 'nested');
      const cwd = path.join(middle, 'work');
      await mkdir(cwd, { recursive: true });
      if (kind === 'file') await writeFile(path.join(root, '.git'), 'gitdir: fictional');
      else await mkdir(path.join(root, '.git'));
      for (const dir of [base, root, middle, cwd]) {
        await mkdir(path.join(dir, '.codex'));
        await writeFile(path.join(dir, '.codex/hooks.json'), '{}');
      }
      for (const rule of ['member', 'config', 'any'] as const) {
        const issues = await inspectProjectCodex({ cwd, rule });
        expect(issues.some((issue) => issue.file === path.join(base, '.codex/hooks.json'))).toBe(false);
        for (const dir of [root, middle, cwd])
          expect(issues.some((issue) => issue.file === path.join(dir, '.codex/hooks.json'))).toBe(true);
      }
    },
  );
});
describe('local Codex configuration checks', () => {
  async function fixture() {
    const cwd = await dirs.make();
    const home = await dirs.make();
    const admin = path.join(home, 'administrator.toml');
    const user = path.join(home, 'config.toml');
    await mkdir(path.join(cwd, '.codex'));
    const project = path.join(cwd, '.codex', 'config.toml');
    return {
      cwd,
      codexHome: home,
      admin,
      user,
      project,
      env: { CODEX_HOME: home },
      locations: { codexManaged: [admin], codexUser: user, codexPresenceRefused: [] },
    };
  }

  it('keeps local sandbox and start roots within the broader ambient refusal roots', () => {
    for (const root of CODEX_SANDBOX_ROOTS) expect(CODEX_OVERRIDING_ROOTS.has(root)).toBe(true);
    for (const root of CODEX_START_ROOTS) expect(CODEX_OVERRIDING_ROOTS.has(root)).toBe(true);
  });

  it.each(['hooks', 'project_root_markers'])(
    'refuses %s in the user and project config of a Codex start, without values (PM-1169)',
    async (root) => {
      for (const source of ['user', 'project'] as const) {
        const input = await fixture();
        await writeFile(input[source], `${root} = "fictional-private-value"\n`);
        expect(await inspectCodexSandboxConfig(input)).toEqual([{ file: input[source], keys: [root] }]);
      }
    },
  );

  it('refuses a user hooks file, an administrator hooks file and a macOS preference file by presence (PM-1169)', async () => {
    const input = await fixture();
    const managed = path.join(input.codexHome, 'managed-hooks.json');
    const plist = path.join(input.codexHome, 'com.openai.codex.plist');
    const locations = { ...input.locations, codexPresenceRefused: [managed, plist] };
    expect(await inspectCodexSandboxConfig({ ...input, locations })).toEqual([]);
    await writeFile(path.join(input.codexHome, 'hooks.json'), 'fictional-private-value');
    await writeFile(managed, 'fictional-private-value');
    await writeFile(plist, 'fictional-private-value');
    const issues = await inspectCodexSandboxConfig({ ...input, locations });
    expect(issues).toEqual([
      { file: path.join(input.codexHome, 'hooks.json'), keys: ['(hooks file)'] },
      { file: managed, keys: ['(hooks file)'] },
      { file: plist, keys: ['(managed preferences)'] },
    ]);
    expect(JSON.stringify(issues)).not.toContain('fictional-private-value');
  });

  it('refuses a presence file that cannot be inspected', async () => {
    const input = await fixture();
    // A name below a symlink loop fails with ELOOP, which is neither "absent" nor readable.
    const loop = path.join(input.codexHome, 'loop');
    await symlink(loop, loop);
    const file = path.join(loop, 'com.openai.codex.plist');
    const locations = { ...input.locations, codexPresenceRefused: [file] };
    expect(await inspectCodexSandboxConfig({ ...input, locations })).toEqual([
      { file, keys: ['(unreadable)'] },
    ]);
  });

  it.each([...CODEX_SANDBOX_ROOTS])(
    'refuses %s in every loaded source, without returning values',
    async (root) => {
      for (const source of ['admin', 'user', 'project'] as const) {
        const input = await fixture();
        await writeFile(input[source], `${root} = "fictional-private-value"\n`);
        expect(await inspectCodexSandboxConfig(input)).toEqual([{ file: input[source], keys: [root] }]);
      }
    },
  );

  it('allows harmless user settings but refuses escaped roots and any administrator content', async () => {
    const input = await fixture();
    await writeFile(input.user, 'model = "fictional-model"\n[mcp_servers.example]\ncommand = "fictional"');
    expect(await inspectCodexSandboxConfig(input)).toEqual([]);
    await writeFile(input.project, String.raw`"sandbox_\u006dode" = "fictional-value"`);
    expect(await inspectCodexSandboxConfig(input)).toEqual([
      { file: input.project, keys: [String.raw`"sandbox_\u006dode"`] },
    ]);
    await writeFile(input.admin, '# administrator policy\n');
    expect((await inspectCodexSandboxConfig(input))[0]).toEqual({
      file: input.admin,
      keys: ['(administrator config)'],
    });
  });

  it('reads user MCP names in order from tables, subtables and dotted keys', async () => {
    const input = await fixture();
    await writeFile(
      input.user,
      '[mcp_servers.node_repl]\ncommand = "fictional-private"\n[mcp_servers.other.env]\nVALUE = "fictional-private"\nmcp_servers.third.enabled = true\n[mcp_servers.node_repl.env]\n',
    );
    expect(await inspectCodexMcpServers(input)).toEqual({
      names: ['node_repl', 'other', 'third'],
      unresolved: [],
    });
  });

  it.each([
    '[mcp_servers."quoted"]\ncommand = "fictional-private"',
    String.raw`[mcp_servers."esca\u0070ed"]`,
    'mcp_servers = { hidden = { command = "fictional-private" } }',
    '[mcp_servers.team]\ncommand = "fictional-private"',
    String.raw`["mcp_\u0073ervers".hidden]`,
    '[mcp_servers]\nhidden = { command = "fictional-private" }',
    '[[mcp_servers.example]]\ncommand = "fictional-private"',
  ])('fails closed on ambiguous user MCP configuration %#', async (text) => {
    const input = await fixture();
    await writeFile(input.user, text);
    const result = await inspectCodexMcpServers(input);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.file).toBe(input.user);
    expect(JSON.stringify(result)).not.toContain('fictional-private');
  });

  it('reports an unreadable user config and accepts a missing one', async () => {
    const input = await fixture();
    expect(await inspectCodexMcpServers(input)).toEqual({ names: [], unresolved: [] });
    await mkdir(input.user);
    expect(await inspectCodexMcpServers(input)).toEqual({
      names: [],
      unresolved: [{ file: input.user, keys: ['(unreadable)'] }],
    });
  });
});
afterEach(() => dirs.cleanup());

describe('the CLI version', () => {
  it('is read from what each CLI prints', () => {
    expect(parseCliVersion('2.1.284 (Claude Code)\n')).toBe('2.1.284');
    expect(parseCliVersion('codex-cli 0.159.1\n')).toBe('0.159.1');
    expect(parseCliVersion('v1.2.3-beta.1')).toBe('1.2.3-beta.1');
    expect(parseCliVersion('')).toBeNull();
    expect(parseCliVersion('Fake 12.3 build')).toBeNull();
    // The numbers of a longer dotted string are not a version.
    expect(parseCliVersion('1.2.3.4')).toBeNull();
  });
});

describe('ambient Codex configuration', () => {
  async function files() {
    const dir = await dirs.make('ambient-');
    return {
      dir,
      at: (name: string) => path.join(dir, name),
      write: async (name: string, text: string) => {
        await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
        await writeFile(path.join(dir, name), text);
        return path.join(dir, name);
      },
    };
  }
  const inspect = (
    provider: AgentProvider,
    cwd: string,
    locations: Parameters<typeof inspectAmbientConfig>[0]['locations'],
  ) =>
    inspectAmbientConfig({ provider, cwd, env: {}, locations: { codexPresenceRefused: [], ...locations } });

  it('refuses project_root_markers and a present preference file for NanoGPT too (PM-1169)', async () => {
    const f = await files();
    const user = await f.write('config.toml', 'project_root_markers = [".hg"]\n');
    const plist = await f.write('com.openai.codex.plist', 'private-value');
    const issues = await inspect('nanogpt', f.at('repo'), {
      codexManaged: [],
      codexUser: user,
      codexPresenceRefused: [plist],
    });
    expect(issues).toEqual([
      { file: user, keys: ['project_root_markers'] },
      { file: plist, keys: ['(managed preferences)'] },
    ]);
  });

  it('flags any content of a Codex administrator file, and the overriding roots of the user and project files', async () => {
    const f = await files();
    const admin = await f.write(
      'requirements.toml',
      '# set by an administrator\nallowed_approval_policies = ["untrusted"]\n',
    );
    const user = await f.write(
      'config.toml',
      [
        'model = "gpt"',
        'approval_policy = "on-request"',
        '[notice]',
        'hide_x = true',
        '[projects."/some/dir"]',
        'trust_level = "trusted"',
        '[mcp_servers.owner]',
        'command = "x"',
        '[hooks]',
        '',
      ].join('\n'),
    );
    await f.write('repo/.codex/config.toml', 'sandbox_mode = "workspace-write"\n');
    const issues = await inspect('codex', f.at('repo'), { codexManaged: [admin], codexUser: user });
    expect(issues).toEqual([
      { file: admin, keys: ['allowed_approval_policies'] },
      { file: user, keys: ['approval_policy', 'mcp_servers', 'hooks'] },
      { file: f.at('repo/.codex/config.toml'), keys: ['sandbox_mode'] },
    ]);
  });

  it.each([
    '["mcp\\u005fservers".x]\ncommand = "private-sentinel"',
    '"mcp\\u005fservers".x.command = "private-sentinel"',
    '["mcp_servers".x]\ncommand = "private-sentinel"',
  ])('refuses quoted overriding Codex roots without reporting values', async (text) => {
    const f = await files();
    const user = await f.write('config.toml', text);
    const issues = await inspect('codex', f.dir, { codexManaged: [], codexUser: user });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toBe(user);
    expect(JSON.stringify(issues)).not.toContain('private-sentinel');
  });

  it("lets Codex's own bookkeeping stand", async () => {
    const f = await files();
    const user = await f.write(
      'config.toml',
      'model = "gpt"\n[notice]\nhide_rate_limit_model_nudge = true\n[projects."/a.b/c"]\ntrust_level = "trusted"\n',
    );
    expect(await inspect('codex', f.dir, { codexManaged: [], codexUser: user })).toEqual([]);
  });

  it.each(['home/hooks.json', 'repo/.codex/hooks.json'])(
    'refuses the separate Codex hook file %s',
    async (name) => {
      const f = await files();
      const file = await f.write(name, 'private-hook-value');
      expect(
        await inspect('codex', f.at('repo'), { codexManaged: [], codexUser: f.at('home/config.toml') }),
      ).toContainEqual({ file, keys: ['(hooks file)'] });
    },
  );

  it.each(['file', 'symlink', 'content'] as const)('refuses a project Codex %s in any mode', async (kind) => {
    const f = await files();
    const folder = f.at('.codex');
    if (kind === 'file') await writeFile(folder, 'private-value');
    else if (kind === 'symlink') {
      await mkdir(f.at('empty'));
      await symlink(f.at('empty'), folder);
    } else await f.write('.codex/anything.txt', 'private-value');
    const request = {
      provider: 'codex' as const,
      cwd: f.dir,
      env: {},
      locations: { codexManaged: [], codexUser: f.at('home/config.toml'), codexPresenceRefused: [] },
    };
    expect(await inspectAmbientConfig({ ...request, projectFolder: 'any' })).toContainEqual({
      file: folder,
      keys: ['(project codex folder)'],
    });
    expect(await inspectAmbientConfig(request)).toEqual(
      kind === 'content' ? [] : [{ file: folder, keys: ['(project codex folder)'] }],
    );
  });
});
