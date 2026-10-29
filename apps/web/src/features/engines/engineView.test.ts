import { describe, expect, it } from 'vitest';
import {
  engineAppDownloadUrl,
  engineCommand,
  engineInitCommand,
  engineServiceStatus,
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

describe('the motor app download link', () => {
  it('is built from the owner and repository of the latest published release', () => {
    expect(engineAppDownloadUrl('https://github.com/acme/tool/releases/tag/v2026.10.11')).toBe(
      'https://github.com/acme/tool/releases/latest/download/projectman-motor.dmg',
    );
  });

  it.each([null, undefined, '', 'u', 'https://example.com/acme/tool/releases/tag/v1'])(
    'is absent for %j',
    (url) => {
      expect(engineAppDownloadUrl(url)).toBeNull();
    },
  );
});
