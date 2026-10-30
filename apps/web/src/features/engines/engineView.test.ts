import { describe, expect, it } from 'vitest';
import type { EngineStatusResponse, EngineStatusView } from '@projectman/shared';
import {
  engineCommand,
  engineInitCommand,
  engineServiceStatus,
  mainFirst,
  projectMainEngine,
  projectSetCommand,
  repoAddCommand,
} from './engineView';

const SHIM = '"$HOME/Library/Application Support/projectman/engine/bin/projectman-engine"';
const ENGINE = { id: 'eng_aaaaaaaaaaaa', name: 'Eszter Mac' };

describe('the commands of each install mode', () => {
  it.each([
    ['app', SHIM],
    ['checkout', 'npm run engine --'],
  ] as const)('start with the %s prefix', (mode, prefix) => {
    expect(engineCommand(ENGINE.id, mode)).toBe(
      `${prefix} init --cloud ${window.location.origin} --id ${ENGINE.id}`,
    );
    expect(engineInitCommand(ENGINE, mode).startsWith(`pbpaste | ${prefix} init `)).toBe(true);
    expect(engineServiceStatus(mode)).toBe(`${prefix} service status`);
    expect(repoAddCommand('SHOP', { name: 'web', path: './web' }, '/work/shop/', mode)).toBe(
      `${prefix} repo add SHOP web /work/shop/web`,
    );
  });

  it('restarts the app-managed service after the project is set, and rewrites the checkout one', () => {
    expect(projectSetCommand('SHOP', '/work/shop', 'app')).toBe(
      `${SHIM} project set SHOP /work/shop && ${SHIM} service restart`,
    );
    expect(projectSetCommand('SHOP', '/work/shop', 'checkout')).toBe(
      'npm run engine -- project set SHOP /work/shop && npm run engine -- service install',
    );
  });
});

describe('the engine of a project (PM-1093)', () => {
  const view = (id: string, isDefault = false): EngineStatusView => ({
    id,
    name: id,
    isDefault,
    online: true,
    lastSeenAt: null,
  });
  const own = view('eng_aaaaaaaaaaaa');
  const global = view('eng_bbbbbbbbbbbb', true);
  const status = (projectEngines?: EngineStatusResponse['projectEngines']): EngineStatusResponse => ({
    mode: 'cloud',
    engines: [global, own],
    ...(projectEngines ? { projectEngines } : {}),
  });

  it.each([
    ['an older server', status(), { main: global, source: 'default' }],
    ['a missing key', status({ OTHER: own.id }), { main: global, source: 'default' }],
    ['a null key', status({ AC: null }), { main: null, source: 'project' }],
    ['a hidden engine', status({ AC: 'eng_cccccccccccc' }), { main: null, source: 'project' }],
    ['a visible engine', status({ AC: own.id }), { main: own, source: 'project' }],
  ])('answers %s', (_name, response, expected) => {
    expect(projectMainEngine(response, 'AC')).toEqual(expected);
  });

  it('puts the main engine first and keeps the order of the rest', () => {
    const rest = view('eng_dddddddddddd');
    expect(mainFirst([global, own, rest], own.id)).toEqual([own, global, rest]);
  });
});
