import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runConfigCheck } from '../../../scripts/live/config-check';
import { runLive } from '../../../scripts/live/commands';
import { createConfigStore } from '../src/config';
import { LiveWorld } from './helpers/live-world';
import { testConfig } from './helpers/test-template';

/** The configuration check (PM-493) and the command line that reaches it. */

const author = { name: 'Owner Person', email: 'owner@example.com' };
let home: string;
let world: LiveWorld;

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'config-check-')));
  world = new LiveWorld();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  world.cleanup();
});

describe('config-check', () => {
  it('refuses a home with no customization repository, and writes nothing', async () => {
    expect(await runConfigCheck(world.deps(), home)).toBe(2);
    expect(world.output).toContain('not a repository');
    mkdirSync(path.join(home, 'customization'));
    expect(await runConfigCheck(world.deps(), home)).toBe(2);
    expect(existsSync(path.join(home, 'customization', '.git'))).toBe(false);
  });

  it('loads every project with the loaders of this build', async () => {
    const store = createConfigStore({ rootDir: path.join(home, 'customization') });
    await store.save('AR', testConfig(), { author, message: 'Create AR' });
    expect(await runConfigCheck(world.deps(), home)).toBe(0);
    expect(world.output).toContain('config-check: AR ok');
  });

  it('exits 1 for a project that does not load, and still checks the others', async () => {
    const store = createConfigStore({ rootDir: path.join(home, 'customization') });
    await store.save('AR', testConfig(), { author, message: 'Create AR' });
    await store.save('BR', testConfig({ key: 'BR' }), { author, message: 'Create BR' });
    writeFileSync(path.join(home, 'customization', 'projects', 'AR', 'team.yaml'), 'members: [');
    expect(await runConfigCheck(world.deps(), home)).toBe(1);
    expect(world.output).toContain('config-check: AR failed:');
    expect(world.output).toContain('config-check: BR ok');
  });
});

describe('the command line', () => {
  const run = async (...argv: string[]) => {
    const code = await runLive(argv, () => world.deps());
    return code;
  };

  it('refuses an unknown command, an unknown option and a missing value with status 2', async () => {
    expect(await run()).toBe(2);
    expect(await run('deploy')).toBe(2);
    expect(await run('status', '--colour', 'red')).toBe(2);
    expect(await run('status', '--home')).toBe(2);
    expect(await run('install', '--port', 'many')).toBe(2);
    expect(world.keys()).toEqual([]);
  });

  it('needs every option of the watcher', async () => {
    expect(await run('watch', '--root', world.root)).toBe(2);
    expect(world.output).toContain('watch needs');
  });

  it('runs config-check on the home it is given', async () => {
    expect(await run('config-check', '--home', home)).toBe(2);
    expect(world.output).toContain(path.join(home, 'customization'));
  });

  it('expands ~/ against the user home', async () => {
    expect(await run('config-check', '--home', '~/data')).toBe(2);
    expect(world.output).toContain(path.join(world.userHome, 'data', 'customization'));
  });
});
