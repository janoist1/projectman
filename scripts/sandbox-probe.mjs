// Fictional fixtures and raw observations for PM-126. Never launches an agent CLI.
import { execFile } from 'node:child_process';
import { appendFile, copyFile, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const source = fileURLToPath(import.meta.url);
const marker = 'projectman PM-126 fictional fixture v2\n';
const response = 'PM-126 fictional listener';

export function layout(root) {
  root = path.resolve(root);
  const data = path.join(root, 'fake-live');
  const repo = path.join(root, 'main-repo');
  return {
    root,
    data,
    repo,
    common: path.join(repo, '.git'),
    own: path.join(data, 'worktrees/T/T-1-repo'),
    other: path.join(data, 'worktrees/T/T-2-repo'),
    outside: path.join(root, 'outside'),
  };
}

// Only fictional git settings, even for host reproduction. No user hooks/signing.
export function fixtureEnv(p) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(p.root, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

export async function assertFixture(p) {
  if ((await readFile(path.join(p.root, '.pm126-fixture'), 'utf8')) !== marker)
    throw new Error('Not a PM-126 fixture');
  if ((await realpath(p.root)) !== p.root) throw new Error('Fixture root must be canonical');
}

export async function setup(root) {
  const p = layout(root);
  // Nonrecursive creation refuses an existing root. Real isolation probes must be outside tmp.
  await mkdir(p.root);
  await writeFile(path.join(p.root, '.pm126-fixture'), marker);
  await writeFile(
    path.join(p.root, 'gitconfig'),
    '[user]\nname = probe\nemail = probe@example.invalid\n[commit]\ngpgsign = false\n',
  );
  for (const dir of [p.data, p.outside, path.join(p.data, 'customization'), path.join(p.data, 'attachments')])
    await mkdir(dir, { recursive: true });
  for (const [name, text] of [
    ['db.sqlite', 'fictional database'],
    ['secret', 'fictional cookie key'],
    ['customization/team.yaml', 'fictional configuration'],
    ['attachments/file.txt', 'fictional attachment'],
  ])
    await writeFile(path.join(p.data, name), text);
  await writeFile(path.join(p.outside, 'secret.txt'), 'fictional credential');
  const git = (...args) => exec('git', args, { env: fixtureEnv(p) });
  await git('init', '-q', '-b', 'main', p.repo);
  await writeFile(path.join(p.repo, 'README.md'), 'fictional repository\n');
  await git('-C', p.repo, 'add', 'README.md');
  await git('-C', p.repo, 'commit', '-qm', 'Initialize fixture');
  await mkdir(path.dirname(p.own), { recursive: true });
  await git('-C', p.repo, 'worktree', 'add', '-q', '-b', 't-1', p.own);
  await git('-C', p.repo, 'worktree', 'add', '-q', '-b', 't-2', p.other);
  await writeFile(path.join(p.other, 'private.txt'), 'fictional other session');
  await copyFile(source, path.join(p.own, 'probe.mjs'));
  await symlink(path.join(p.data, 'secret'), path.join(p.own, 'secret-link'));
  await mkdir(path.join(p.own, 'npm-probe'));
  await writeFile(
    path.join(p.own, 'npm-probe/package.json'),
    JSON.stringify({
      name: 'npm-probe',
      version: '1.0.0',
      private: true,
      dependencies: { 'is-number': '7.0.0' },
    }),
  );
  await writeFile(
    path.join(p.own, 'claude-strict.json'),
    JSON.stringify(
      {
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          failIfUnavailable: true,
          filesystem: {
            denyRead: [p.data, p.outside],
            allowRead: [p.own, p.common],
            allowWrite: [path.join(p.own, 'npm-cache')],
          },
          network: {
            allowedDomains: ['registry.npmjs.org', 'github.com', 'api.github.com'],
            strictAllowlist: true,
            allowLocalBinding: false,
          },
        },
      },
      null,
      2,
    ),
  );
  return p;
}

export async function observe(name, expected, action) {
  try {
    await action();
    return { name, expected, observed: 'allowed', meetsExpectation: expected === 'allow' };
  } catch (error) {
    // Missing files, DNS failures, closed listeners and invalid commands do not prove denial.
    const denied = error.code === 'EACCES' || error.code === 'EPERM';
    return {
      name,
      expected,
      observed: denied ? 'denied' : 'failed-unclassified',
      meetsExpectation: denied && expected === 'deny',
      code: error.code ?? null,
      stderr: String(error.stderr ?? error.message).slice(0, 2000),
    };
  }
}

async function request(url, socketPath) {
  await new Promise((resolve, reject) => {
    const parsed = socketPath ? null : new URL(url);
    const options = socketPath
      ? { socketPath, path: '/' }
      : {
          hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
          port: parsed.port,
          path: '/',
          ...(parsed.hostname === 'localhost' ? { family: 4 } : {}),
        };
    const req = http.get(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () =>
        res.statusCode === 200 && body === response ? resolve() : reject(new Error('Wrong fixture listener')),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Fixture request timed out')));
  });
}

export async function serve(p, ports = { ipv4: 48999, ipv6: 49000 }) {
  await assertFixture(p);
  const servers = [];
  try {
    for (const address of [
      { host: '127.0.0.1', port: ports.ipv4 },
      { host: '::1', port: ports.ipv6, ipv6Only: true },
      path.join(p.own, 'live.sock'),
    ]) {
      const server = http.createServer((_, res) => res.end(response));
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(address, resolve);
      });
    }
  } catch (error) {
    for (const server of servers) if (server.listening) server.close();
    throw error;
  }
  return servers;
}

export async function networkChecks(p, baseline = false, ports = { ipv4: 48999, ipv6: 49000 }) {
  const expected = baseline ? 'allow' : 'deny';
  const results = [];
  for (const [name, url] of [
    ['ipv4', `http://127.0.0.1:${ports.ipv4}/`],
    ['localhost', `http://localhost:${ports.ipv4}/`],
    ['ipv6', `http://[::1]:${ports.ipv6}/`],
  ])
    results.push(await observe(`net_${name}`, expected, () => request(url)));
  results.push(
    await observe('net_unix_socket', expected, () => request(null, path.join(p.own, 'live.sock'))),
  );
  return results;
}

export async function checks(p) {
  // The fixture marker is intentionally outside permitted read roots, so do not read it here.
  if ((await realpath(process.cwd())) !== p.own)
    throw new Error('Run checks from the fictional own worktree');
  const results = [];
  const check = async (name, expected, action) => results.push(await observe(name, expected, action));
  const write = (file) => writeFile(file, 'fictional probe write\n');
  const git = (...args) => exec('git', ['-C', p.own, ...args], { timeout: 10000 });
  await check('write_cwd', 'allow', () => write(path.join(p.own, 'probe-write.txt')));
  await check('shell_features', 'allow', () =>
    exec('sh', ['-c', 'value=fictional; printf "%s\\n" "$value-$(printf substitution)" > shell-write.txt'], {
      cwd: p.own,
      timeout: 10000,
    }),
  );
  await check('write_tmp', 'allow', () => write(path.join(tmpdir(), `pm126-${process.pid}.txt`)));
  for (const [name, file] of [
    ['data', path.join(p.data, 'db.sqlite')],
    ['cookie_secret', path.join(p.data, 'secret')],
    ['customization', path.join(p.data, 'customization/team.yaml')],
    ['attachment', path.join(p.data, 'attachments/file.txt')],
    ['other_worktree', path.join(p.other, 'private.txt')],
    ['credential', path.join(p.outside, 'secret.txt')],
    ['symlink_secret', path.join(p.own, 'secret-link')],
  ]) {
    await check(`read_${name}`, 'deny', () => readFile(file));
    await check(`write_${name}`, 'deny', () => write(file));
  }
  await check('git_add', 'allow', () => git('add', 'probe-write.txt'));
  await check('git_commit', 'allow', () =>
    git(
      '-c',
      'user.name=probe',
      '-c',
      'user.email=probe@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'Probe sandbox write',
    ),
  );
  await check('write_shared_hooks', 'deny', () => write(path.join(p.common, 'hooks/probe-hook')));
  await check('write_shared_config', 'deny', () => git('config', 'probe.key', '1'));
  await check('write_shared_config_direct', 'deny', () =>
    appendFile(path.join(p.common, 'config'), '\n[probe]\n\tdirect = true\n'),
  );
  for (const [name, url, expected] of [
    ['npm', 'https://registry.npmjs.org/-/ping', 'allow'],
    ['github', 'https://github.com', 'allow'],
    ['github_api', 'https://api.github.com', 'allow'],
    ['other_host', 'https://example.com', 'deny'],
  ])
    await check(`net_${name}`, expected, () =>
      exec('curl', ['-q', '--fail', '--silent', '--show-error', '--max-time', '8', url], { timeout: 10000 }),
    );
  results.push(...(await networkChecks(p)));
  await check('test_self_loop', 'allow', async () => {
    const server = http.createServer((_, res) => res.end(response));
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      await request(`http://127.0.0.1:${server.address().port}/`);
    } finally {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
  });
  await check('npm_install_fresh_cache', 'allow', () =>
    exec(
      'npm',
      ['install', '--cache', path.join(p.own, 'npm-cache'), '--prefer-online', '--no-audit', '--no-fund'],
      { cwd: path.join(p.own, 'npm-probe'), timeout: 60000 },
    ),
  );
  return results;
}

// Plant inside the sandbox; trigger separately on the host. Writes fictional marker files only.
export async function plant(p, variant) {
  if (!['hook', 'config-hooks', 'config-fsmonitor'].includes(variant))
    throw new Error('Unknown plant variant');
  const hookDir = variant === 'hook' ? path.join(p.common, 'hooks') : path.join(p.own, 'owned-hooks');
  await mkdir(hookDir, { recursive: true });
  const script = path.join(hookDir, variant === 'config-fsmonitor' ? 'fsmonitor' : 'post-checkout');
  const target = path.join(p.data, `${variant}-executed.txt`);
  const quoted = `'${target.replaceAll("'", "'\\''")}'`;
  await writeFile(script, `#!/bin/sh\nprintf 'fictional host execution\\n' > ${quoted}\n`, { mode: 0o755 });
  if (variant !== 'hook')
    await exec('git', [
      '-C',
      p.own,
      'config',
      variant === 'config-hooks' ? 'core.hooksPath' : 'core.fsmonitor',
      variant === 'config-hooks' ? hookDir : script,
    ]);
  return { script, target };
}

if (process.argv[1] && path.resolve(process.argv[1]) === source) {
  const command = process.argv[2];
  const p = layout(process.argv[3] ?? path.join(homedir(), 'projectman-sandbox-probe-v2'));
  if (command === 'setup') console.log(JSON.stringify(await setup(p.root), null, 2));
  else if (command === 'serve') {
    await serve(p);
    console.log('Ready: fictional IPv4, IPv6 and Unix listeners. Stop with Ctrl-C.');
  } else if (command === 'baseline') {
    await assertFixture(p);
    console.log(JSON.stringify(await networkChecks(p, true), null, 2));
  } else if (command === 'checks') console.log(JSON.stringify(await checks(p), null, 2));
  else if (command === 'plant') console.log(JSON.stringify(await plant(p, process.argv[4]), null, 2));
  else
    throw new Error(
      'Usage: sandbox-probe.sh setup|serve|baseline|checks|plant [absolute fixture root] [hook|config-hooks|config-fsmonitor]',
    );
}
