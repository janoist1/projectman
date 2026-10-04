#!/usr/bin/env node
/**
 * The browser for `npm run shots` (PM-270).
 *
 *   npm run browsers -- install   download the headless Chromium into the browsers folder
 *   npm run browsers -- check     say whether it is there, and which version
 *
 * The folder is $PROJECTMAN_BROWSERS_PATH, else ~/.projectman/browsers. A person runs `install`, in a
 * normal terminal outside any member's sandbox (it downloads from the Playwright CDN and writes below
 * ~/.projectman); the members only read the folder. On Linux `install` also installs the system
 * libraries (`--with-deps`), which needs the right to install packages.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BROWSER_NAME, browserStatus } from './lib/browser.mjs';

const cli = fileURLToPath(new URL('../node_modules/playwright-core/cli.js', import.meta.url));
const USAGE = 'Usage: npm run browsers -- install|check';

function describe(status) {
  return `${BROWSER_NAME} ${status.version} (revision ${status.revision})`;
}

function check() {
  const status = browserStatus();
  if (status.installed) {
    console.log(`${describe(status)}: installed in ${status.path}`);
    return 0;
  }
  console.log(
    `${describe(status)}: missing from ${status.path}\nInstall it with: npm run browsers -- install`,
  );
  return 1;
}

function install() {
  const status = browserStatus();
  const args = [cli, 'install', ...(process.platform === 'linux' ? ['--with-deps'] : []), BROWSER_NAME];
  console.log(`Installing ${describe(status)} into ${status.path}`);
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: status.path },
  });
  if (result.error || result.status !== 0) {
    console.error(`The installation failed (${result.error?.message ?? `exit code ${result.status}`}).`);
    return 1;
  }
  return check();
}

const command = process.argv.slice(2);
if (command.length !== 1 || !['install', 'check'].includes(command[0])) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  process.exitCode = command[0] === 'install' ? install() : check();
}
