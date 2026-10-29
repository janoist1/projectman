import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runEngineCli } from '../../../scripts/engine/commands';
import type { EngineCliIo } from '../../../scripts/engine/commands';
import {
  installedServiceFor,
  installService,
  PLIST_TEMPLATE,
  renderPlist,
  reportService,
  restartService,
  SERVICE_LABEL,
  servicePathEnv,
  servicePaths,
  startService,
  stopService,
  uninstallService,
} from '../../../scripts/engine/service';
import type { LaunchctlResult, ServiceOptions } from '../../../scripts/engine/service';
import { BILLING_ENV_VARS } from '../src/runner/env';
import { writeInstanceMarker } from '../src/instance';

/**
 * The engine as a LaunchAgent (PM-318): the file is rendered from the template with absolute paths and
 * nothing of the installing shell's environment but PATH; launchctl is a fake that records its calls.
 */

const ROOT = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
const TEMPLATE = readFileSync(path.join(ROOT, PLIST_TEMPLATE), 'utf8');

describe('the plist template', () => {
  const values = {
    label: SERVICE_LABEL,
    node: '/opt/homebrew/bin/node',
    root: '/Users/me/projectman-live',
    path: '/opt/homebrew/bin:/usr/bin',
    home: '/Users/me/.projectman',
    logOut: '/Users/me/.projectman/logs/engine-service.out.log',
    logErr: '/Users/me/.projectman/logs/engine-service.err.log',
  };

  const withoutComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, '');

  it('starts the engine mode on the home, at load and again after an exit', () => {
    const plist = withoutComments(renderPlist(TEMPLATE, values));
    expect(plist).not.toMatch(/\{\{/);
    expect(plist).toContain('<string>com.projectman.engine</string>');
    expect(plist).toContain('<string>/opt/homebrew/bin/node</string>');
    expect(plist).toContain('<string>/Users/me/projectman-live/apps/server/dist/index.js</string>');
    expect(plist).not.toContain('<string>tsx</string>');
    expect(plist).toMatch(/<key>PROJECTMAN_MODE<\/key>\s*<string>engine<\/string>/);
    expect(plist).toMatch(/<key>PROJECTMAN_HOME<\/key>\s*<string>\/Users\/me\/\.projectman<\/string>/);
    expect(plist).toMatch(/<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    // The shutdown pause (60 s + 20 s cap) must fit before launchd's SIGKILL.
    expect(plist).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>100<\/integer>/);
    expect(plist).toContain('<string>/Users/me/.projectman/logs/engine-service.out.log</string>');
  });

  it('names no billing variable and no integrator key', () => {
    // The template's own comment names the integrator key to say it is absent; the settings are what count.
    const plist = withoutComments(renderPlist(TEMPLATE, values));
    for (const name of BILLING_ENV_VARS) expect(plist).not.toContain(name);
    expect(plist).not.toContain('PROJECTMAN_INTEGRATOR_KEY');
    expect(plist).not.toMatch(/API_KEY|TOKEN/);
    // The environment holds exactly these three variables.
    const environment = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist)![1]!;
    expect([...environment.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual([
      'PATH',
      'PROJECTMAN_MODE',
      'PROJECTMAN_HOME',
    ]);
  });

  it('escapes what a path may hold, and refuses a placeholder it does not know', () => {
    expect(renderPlist(TEMPLATE, { ...values, home: '/Users/a&b/<x>' })).toContain(
      '/Users/a&amp;b/&lt;x&gt;',
    );
    expect(() => renderPlist('<string>{{NOPE}}</string>', values)).toThrow(/NOPE/);
  });
});

describe('service install, uninstall and status', () => {
  let base: string;
  let calls: string[][];
  let responses: Record<string, LaunchctlResult>;
  let output: string[];
  let waits: number[];

  const options = (overrides: Partial<ServiceOptions> = {}): ServiceOptions => ({
    home: path.join(base, 'home'),
    root: ROOT,
    nodePath: '/opt/homebrew/bin/node',
    pathEnv: '/opt/homebrew/bin:/usr/bin',
    agentsDir: path.join(base, 'LaunchAgents'),
    uid: 501,
    platform: 'darwin',
    launchctl: (args) => {
      calls.push(args);
      return responses[args[0]!] ?? { status: 0, stdout: '', stderr: '' };
    },
    out: (text) => output.push(text),
    sleep: (ms) => waits.push(ms),
    ...overrides,
  });

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'engine-service-')));
    mkdirSync(path.join(base, 'home'));
    calls = [];
    responses = {};
    output = [];
    waits = [];
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('writes the agent into LaunchAgents and loads it into the gui domain', () => {
    installService(options());
    const { plist, logOut } = servicePaths(options());
    expect(plist).toBe(path.join(base, 'LaunchAgents', 'com.projectman.engine.plist'));
    const text = readFileSync(plist, 'utf8');
    expect(text).toContain(`<string>${path.join(base, 'home')}</string>`);
    expect(text).toContain(`<string>${ROOT}/apps/server/dist/index.js</string>`);
    expect(calls).toEqual([
      ['bootout', 'gui/501/com.projectman.engine'],
      ['bootstrap', 'gui/501', plist],
    ]);
    // The service's logs go to the engine's home, which no session may read.
    expect(statSync(path.dirname(logOut)).mode & 0o777).toBe(0o700);
    expect(output.join('\n')).toContain(logOut);
  });

  it('reports a failed bootstrap with launchctl’s own words, after a few tries on the busy error', () => {
    responses.bootstrap = { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
    expect(() => installService(options())).toThrow(/launchctl bootstrap failed \(5\).*Input\/output error/);
    expect(calls.filter((c) => c[0] === 'bootstrap')).toHaveLength(5);
    expect(waits).toEqual([500, 500, 500, 500]);
  });

  it('loads on a retry when launchd was still tearing down the old job', () => {
    let attempts = 0;
    installService(
      options({
        launchctl: (args) => {
          calls.push(args);
          if (args[0] === 'bootstrap' && (attempts += 1) < 3)
            return { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
          return { status: 0, stdout: '', stderr: '' };
        },
      }),
    );
    expect(calls.filter((c) => c[0] === 'bootstrap')).toHaveLength(3);
    expect(output.join('\n')).toContain('engine service installed');
  });

  it('does not retry another failure', () => {
    responses.bootstrap = { status: 113, stdout: '', stderr: 'Could not find specified service' };
    expect(() => installService(options())).toThrow(/bootstrap failed \(113\)/);
    expect(calls.filter((c) => c[0] === 'bootstrap')).toHaveLength(1);
  });

  it('leaves the installing run’s node_modules/.bin folders out of the file’s PATH', () => {
    const pathEnv = [
      '/Users/me/projectman-live/node_modules/.bin',
      '/Users/me/node_modules/.bin',
      '/opt/homebrew/bin',
      '/usr/bin',
    ].join(':');
    expect(servicePathEnv(pathEnv)).toBe('/opt/homebrew/bin:/usr/bin');
    installService(options({ pathEnv }));
    const text = readFileSync(servicePaths(options()).plist, 'utf8');
    expect(text).toContain('<string>/opt/homebrew/bin:/usr/bin</string>');
    expect(text).not.toContain('.bin');
    expect(() => installService(options({ pathEnv: '/x/node_modules/.bin' }))).toThrow(/PATH is empty/);
  });

  it('is found for its home only', () => {
    installService(options());
    const agentsDir = path.join(base, 'LaunchAgents');
    expect(installedServiceFor(path.join(base, 'home'), agentsDir)).toBe(servicePaths(options()).plist);
    expect(installedServiceFor(path.join(base, 'other-home'), agentsDir)).toBeNull();
    expect(installedServiceFor(path.join(base, 'home'), path.join(base, 'no-agents'))).toBeNull();
  });

  it('replaces its own file, but not the agent of another home', () => {
    installService(options());
    installService(options());
    expect(() => installService(options({ home: path.join(base, 'other-home') }))).toThrow(
      /service for .*home is installed/,
    );
  });

  it('refuses where there is no launchd', () => {
    expect(() => installService(options({ platform: 'linux' }))).toThrow(/macOS LaunchAgent/);
    expect(calls).toEqual([]);
  });

  it('unloads and removes the file, keeps the logs, and a second uninstall is no error', () => {
    installService(options());
    mkdirSync(path.join(base, 'home', 'logs'), { recursive: true });
    writeFileSync(servicePaths(options()).logOut, 'log\n');
    calls.length = 0;
    uninstallService(options());
    expect(calls).toEqual([['bootout', 'gui/501/com.projectman.engine']]);
    expect(existsSync(servicePaths(options()).plist)).toBe(false);
    expect(existsSync(servicePaths(options()).logOut)).toBe(true);
    responses.bootout = { status: 3, stdout: '', stderr: 'No such process' };
    uninstallService(options());
    expect(output.at(-1)).toBe('no engine service was installed');
  });

  it('shows whether launchd runs it', () => {
    installService(options());
    responses.print = { status: 0, stdout: '\tstate = running\n\tpid = 4321\n', stderr: '' };
    expect(reportService(options())).toBe(true);
    expect(output.join('\n')).toContain('running (pid 4321)');
    responses.print = { status: 113, stdout: '', stderr: 'Could not find service' };
    expect(reportService(options())).toBe(false);
    expect(output.at(-1)).toBe('launchd: not loaded');
  });

  describe('start, stop and restart', () => {
    const verbs = () => calls.map((c) => c.join(' '));
    const plistFile = () => servicePaths(options()).plist;
    const install = () => {
      installService(options());
      calls.length = 0;
    };
    const loaded = (state: 'running' | 'waiting') => {
      responses.print = {
        status: 0,
        stdout: `\tstate = ${state}\n${state === 'running' ? '\tpid = 9\n' : ''}`,
        stderr: '',
      };
    };
    const notLoaded = () => {
      responses.print = { status: 113, stdout: '', stderr: 'Could not find service' };
    };

    it('start without a file is refused with the way out, and calls nothing to change', () => {
      expect(() => startService(options())).toThrow(/service_not_installed|service install/);
      expect(verbs()).toEqual([]);
    });

    it('start loads the file when launchd does not know the job, with the busy retry', () => {
      install();
      notLoaded();
      let attempts = 0;
      startService(
        options({
          launchctl: (args) => {
            calls.push(args);
            if (args[0] === 'print') return responses.print!;
            return attempts++ < 1 && args[0] === 'bootstrap'
              ? { status: 5, stdout: '', stderr: 'busy' }
              : { status: 0, stdout: '', stderr: '' };
          },
        }),
      );
      expect(calls.filter((c) => c[0] === 'bootstrap')).toHaveLength(2);
      expect(calls.some((c) => c[0] === 'kickstart')).toBe(false);
    });

    it('start kicks a loaded job that is not running, and leaves a running one alone', () => {
      install();
      loaded('waiting');
      startService(options());
      expect(verbs()).toEqual([
        'print gui/501/com.projectman.engine',
        'kickstart gui/501/com.projectman.engine',
      ]);
      calls.length = 0;
      loaded('running');
      startService(options());
      expect(verbs()).toEqual(['print gui/501/com.projectman.engine']);
      expect(output.at(-1)).toContain('already running');
    });

    it('stop unloads the job, keeps the file, and treats "not loaded" as done', () => {
      install();
      notLoaded();
      responses.bootout = { status: 3, stdout: '', stderr: 'No such process' };
      stopService(options());
      expect(verbs()).toEqual([
        'print gui/501/com.projectman.engine',
        'bootout gui/501/com.projectman.engine',
      ]);
      expect(existsSync(plistFile())).toBe(true);
      expect(output.join('\n')).toContain('paused');
    });

    it('stop waits for the pid it read before the bootout, though launchd forgets the job at once', () => {
      install();
      loaded('running');
      let checks = 0;
      const gone = options({
        launchctl: (args) => {
          calls.push(args);
          // After the bootout launchd no longer knows the job.
          return args[0] === 'print' && !calls.some((c) => c[0] === 'bootout')
            ? responses.print!
            : { status: args[0] === 'print' ? 113 : 0, stdout: '', stderr: '' };
        },
        isRunning: (pid) => {
          expect(pid).toBe(9);
          return (checks += 1) <= 3;
        },
      });
      stopService(gone);
      expect(waits).toEqual([1000, 1000, 1000]);
      expect(verbs().filter((v) => v.startsWith('print'))).toHaveLength(1);
    });

    it('stop gives up after 100 s when the engine does not leave', () => {
      install();
      loaded('running');
      expect(() => stopService(options({ isRunning: () => true }))).toThrow(/did not leave within 100 s/);
      expect(waits).toHaveLength(100);
    });

    it('restart is kickstart -k, and starts a job launchd does not know', () => {
      install();
      loaded('running');
      restartService(options());
      expect(verbs()).toEqual([
        'print gui/501/com.projectman.engine',
        'kickstart -k gui/501/com.projectman.engine',
      ]);
      calls.length = 0;
      notLoaded();
      restartService(options());
      expect(verbs()).toEqual(['print gui/501/com.projectman.engine', `bootstrap gui/501 ${plistFile()}`]);
    });

    it('touches nothing of the agent of another home', () => {
      install();
      const other = options({ home: path.join(base, 'other-home') });
      for (const act of [startService, stopService, restartService])
        expect(() => act(other)).toThrow(/service for .*home is installed/);
      expect(calls).toEqual([]);
    });
  });
});

describe('npm run engine -- service', () => {
  let base: string;
  let home: string;
  let workspace: string;
  let calls: string[][];
  let out: string[];
  let err: string[];

  const run = (...argv: string[]) => {
    const io: EngineCliIo = {
      env: { PATH: '/opt/homebrew/bin:/usr/bin', ANTHROPIC_API_KEY: 'sk-must-not-travel' },
      cwd: base,
      tmpdir: path.join(base, 'system-tmp'),
      readStdin: async () => null,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      startEngine: async () => 0,
      isRunning: () => false,
      launchd: {
        root: ROOT,
        nodePath: '/opt/homebrew/bin/node',
        agentsDir: path.join(base, 'LaunchAgents'),
        uid: 501,
        platform: 'darwin',
        launchctl: (args) => {
          calls.push(args);
          return { status: 0, stdout: args[0] === 'print' ? 'state = running\npid = 7\n' : '', stderr: '' };
        },
      },
    };
    return runEngineCli([...argv, '--home', home], io);
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'engine-service-cli-')));
    home = path.join(base, 'home');
    workspace = path.join(base, 'work');
    mkdirSync(workspace, { recursive: true });
    calls = [];
    out = [];
    err = [];
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const configure = async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, 'engine.key'), 'machine-key-0123456789abcdef\n', { mode: 0o600 });
    writeFileSync(
      path.join(home, 'engine.json'),
      JSON.stringify({
        schemaVersion: 1,
        cloudUrl: 'https://cloud.example.com',
        engineId: 'eng_aaaaaaaaaaaa',
        projects: [{ project: 'PM', workspacePath: workspace }],
        repos: [],
      }),
      { mode: 0o600 },
    );
  };

  it('does not install a service that would only crash: no configuration, no key', async () => {
    expect(await run('service', 'install')).toBe(1);
    expect(err.join('\n')).toContain('config_missing');
    expect(calls).toEqual([]);
  });

  it('does not install it on a home with a server database that is not marked as the engine’s', async () => {
    await configure();
    writeFileSync(path.join(home, 'db.sqlite'), '');
    expect(await run('service', 'install')).toBe(1);
    expect(err.join('\n')).toContain('home_in_use');
    expect(calls).toEqual([]);
  });

  it('installs on an engine home, and its file holds nothing of the shell but PATH', async () => {
    await configure();
    writeFileSync(path.join(home, 'db.sqlite'), '');
    writeInstanceMarker(home, 'engine', 'hybrid');
    expect(await run('service', 'install')).toBe(0);
    const plist = readFileSync(path.join(base, 'LaunchAgents', 'com.projectman.engine.plist'), 'utf8');
    expect(plist).toContain('/opt/homebrew/bin:/usr/bin');
    expect(plist).not.toContain('sk-must-not-travel');
    expect(plist).not.toContain('ANTHROPIC_API_KEY');
    expect(calls.map((c) => c[0])).toEqual(['bootout', 'bootstrap']);
  });

  it('reports the state with the exit status: 0 only when it runs', async () => {
    expect(await run('service', 'status')).toBe(0);
    expect(out.join('\n')).toContain('running (pid 7)');
    expect(await run('service', 'uninstall')).toBe(0);
    expect(await run('service', 'frobnicate')).toBe(2);
  });
});
