import { describe, expect, it } from 'vitest';
import { processShortName } from './process-name';

describe('processShortName', () => {
  it('takes the last part of the program', () => {
    expect(processShortName('/usr/bin/sleep 600')).toBe('sleep');
    expect(processShortName('/sbin/launchd')).toBe('launchd');
    expect(processShortName('-zsh')).toBe('zsh');
    expect(processShortName('')).toBe('');
  });

  it('names an interpreter by its first argument that is no flag', () => {
    expect(processShortName('node /srv/app/server.js --port 1')).toBe('server');
    expect(processShortName('/opt/homebrew/bin/node --enable-source-maps /srv/run.mjs')).toBe('run');
    expect(processShortName('python3 -m pytest -q')).toBe('pytest');
    expect(processShortName('python3.12 tool.py')).toBe('tool.py');
    expect(processShortName('bash ./scripts/deploy.sh')).toBe('deploy.sh');
    expect(processShortName('node')).toBe('node');
    expect(processShortName('/bin/sh -c echo hi')).toBe('echo');
  });

  it('names a package run from node_modules by the package', () => {
    expect(processShortName('node /x/node_modules/vitest/vitest.mjs run')).toBe('vitest');
    expect(processShortName('node /x/node_modules/vitest/dist/workers/forks.js')).toBe('vitest');
    expect(processShortName('node /x/node_modules/vite/bin/vite.js --port 5173')).toBe('vite');
    expect(processShortName('node /x/node_modules/typescript/bin/tsc --noEmit')).toBe('tsc');
    expect(processShortName('node /x/node_modules/playwright/cli.js test')).toBe('playwright');
    expect(processShortName('node /x/node_modules/.bin/vite')).toBe('vite');
    expect(processShortName('node /x/node_modules/@esbuild/darwin-arm64/bin/esbuild --service')).toBe(
      'esbuild',
    );
  });

  it('skips the run word of a package runner', () => {
    expect(processShortName('npm run dev')).toBe('dev');
    expect(processShortName('npm test')).toBe('test');
    expect(processShortName('npx vitest')).toBe('vitest');
  });

  it('keeps the spaces of a macOS application and drops its role in brackets', () => {
    expect(processShortName('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBe(
      'Google Chrome',
    );
    expect(
      processShortName(
        '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/129/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --lang=en-US',
      ),
    ).toBe('Google Chrome Helper');
  });

  it('is at most 40 characters', () => {
    expect(processShortName(`/usr/bin/${'x'.repeat(80)}`)).toHaveLength(40);
  });
});
