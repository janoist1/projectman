#!/usr/bin/env node
/**
 * Screenshots of a disposable instance (PM-270): starts the instance (PM-269), runs the member's
 * scenario in a headless browser, writes the images, stops everything. See docs/SCREENSHOTS.md.
 *
 *   npm run shots -- <scenario.mjs> [--out <dir>] [--widths 1512,800,390,375] [--full-page]
 *                    [--scale 1|2] [--timeout <seconds>] [--seed demo|none] [--keep-data]
 *
 * Exit code: 0 done, 1 the scenario (or the instance) failed, 2 wrong use or no browser.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UsageError, createScenarioApi, launchBrowser, outputDirectory, parseArgs } from './lib/browser.mjs';
import { startInstance } from './lib/instance.mjs';

const CLOSE_TIMEOUT_MS = 15_000;

async function loadScenario(file) {
  let module;
  try {
    module = await import(pathToFileURL(resolve(file)).href);
  } catch (err) {
    throw new UsageError(`Cannot load the scenario ${file}: ${err.message}`);
  }
  if (typeof module.default !== 'function')
    throw new UsageError(`The scenario ${file} must export a default async function.`);
  // A scenario may also export `fakeEnv`: FAKE_CLAUDE_*, FAKE_CODEX_* variables for the fake CLIs (PM-324).
  return { run: module.default, fakeEnv: module.fakeEnv ?? {} };
}

/** Rejects when a signal arrives or the time is up; `cancel()` drops the timer and the handlers. */
function interruption(timeoutSeconds) {
  let timer;
  const handlers = new Map();
  const promise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The scenario did not finish in ${timeoutSeconds} s (--timeout).`)),
      timeoutSeconds * 1000,
    );
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => reject(new Error(`Stopped by ${signal}.`));
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
  });
  promise.catch(() => {});
  const cancel = () => {
    clearTimeout(timer);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  return { promise, cancel };
}

async function within(promise, ms) {
  let timer;
  try {
    await Promise.race([promise, new Promise((res) => (timer = setTimeout(res, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { run: scenario, fakeEnv } = await loadScenario(options.scenario);
  const out = outputDirectory({ out: options.out, scenario: options.scenario });
  const stopper = interruption(options.timeoutSeconds);
  let browser;
  let instance;
  let starting;
  try {
    browser = await launchBrowser();
    const dir = options.keepData ? mkdtempSync(join(tmpdir(), 'projectman-shots-data-')) : undefined;
    // This script handles SIGINT/SIGTERM itself (below): the browser stops first, then the instance,
    // and the exit code is 1, not the signal's.
    starting = startInstance({ seed: options.seed, handleSignals: false, fakeEnv, ...(dir ? { dir } : {}) });
    instance = await Promise.race([starting, stopper.promise]);
    if (dir) console.log(`data kept in ${instance.dir}`);
    const api = createScenarioApi({ ...options, browser, instance, out });
    const died = instance.closed.then((err) => (err ? Promise.reject(err) : new Promise(() => {})));
    // A crashed browser fails the run at once, not at the timeout.
    const crashed = new Promise((_, reject) =>
      browser.on('disconnected', () => reject(new Error('The browser exited (it crashed).'))),
    );
    crashed.catch(() => {});
    await Promise.race([scenario(api), stopper.promise, died, crashed]);
  } finally {
    // The signal handlers stay until everything has stopped: a signal during the cleanup must not end
    // the process by the signal and leave the browser's or the instance's folder behind.
    // The browser first, then the instance: the browser talks to its web.
    await within(
      browser?.close().catch(() => {}),
      CLOSE_TIMEOUT_MS,
    );
    // An interruption during the start leaves the instance still starting: wait for it, then stop it.
    instance ??= await starting?.catch(() => undefined);
    await instance?.stop();
    stopper.cancel();
  }
}

try {
  await main();
} catch (err) {
  console.error(err.message);
  process.exitCode = err instanceof UsageError ? 2 : 1;
}
// A scenario may leave timers or sockets behind; everything we started has stopped by now.
process.exit();
