import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** The machine end of the admin channel (PM-749): `host.sh release-control`, with a stand-in for `docker`. */

const script = fs
  .readFileSync(new URL('../../../deploy/aws/host.sh', import.meta.url), 'utf8')
  .replace(/\nmain "\$@"\s*$/, '');

let directory: string;
beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-control-host-')));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

interface Options {
  running?: boolean;
  dockerStatus?: number;
  answer?: string;
  args?: string[];
}

/** Runs `release_control` from the real script; only `docker` and `board_running` are replaced. */
function relay(
  input: string | Buffer,
  { running = true, dockerStatus = 0, answer = '', args = [] }: Options = {},
) {
  const argv = path.join(directory, 'docker-argv');
  const stdin = path.join(directory, 'docker-stdin');
  const response = path.join(directory, 'docker-answer');
  fs.writeFileSync(response, answer);
  const program = `${script}
board_running() { ${running ? 'return 0' : 'return 1'}; }
docker() {
  printf '%s\\n' "$@" > ${JSON.stringify(argv)}
  cat > ${JSON.stringify(stdin)}
  cat ${JSON.stringify(response)}
  return ${dockerStatus}
}
release_control "$@"
`;
  const result = spawnSync('bash', ['-c', program, 'host.sh', ...args], { input, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    docker: fs.existsSync(argv) ? fs.readFileSync(argv, 'utf8').trimEnd().split('\n') : null,
    received: fs.existsSync(stdin) ? fs.readFileSync(stdin) : null,
  };
}

describe('host.sh release-control', () => {
  it('runs the packaged client in the board container as its data user, on the fixed socket', () => {
    const line = '{"op":"status"}\n';
    const result = relay(line, { answer: '{"ok":true,"pause":null}\n' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"ok":true,"pause":null}\n');
    expect(result.docker).toEqual([
      'exec',
      '-i',
      '-u',
      '10001:10001',
      'projectman-cloud',
      'node',
      '/app/apps/server/dist/control/cli.js',
      '/data/control.sock',
    ]);
    expect(result.received?.toString()).toBe(line);
  });

  it('opens no tty, port, mount or environment of the input', () => {
    const { docker } = relay('{"op":"status"}\n');
    expect(docker).not.toContain('-t');
    expect(docker!.join(' ')).not.toMatch(/ -p |--publish|-v |--volume|--mount|-e |--env|--privileged|--net/);
  });

  it('never passes more than the request limit and one byte on', () => {
    const result = relay(Buffer.from('x'.repeat(100_000)));
    expect(result.received!.length).toBe(16 * 1024 + 1);
  });

  it('takes no argument, so nothing from the caller becomes a command', () => {
    const result = relay('{"op":"status"}\n', { args: ['sh', '-c', 'id'] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('takes no arguments');
    expect(result.docker).toBeNull();
  });

  it('refuses while the board does not run, without touching docker', () => {
    const result = relay('{"op":"status"}\n', { running: false });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('refused');
    expect(result.docker).toBeNull();
  });

  it("maps the client's refusal (status 2) to a refusal and any other failure to a failure", () => {
    expect(relay('x\n', { dockerStatus: 2 }).status).toBe(3);
    expect(relay('x\n', { dockerStatus: 1 }).status).toBe(1);
    expect(relay('x\n', { dockerStatus: 64 }).status).toBe(1);
    expect(relay('x\n', { dockerStatus: 125 }).status).toBe(1);
  });
});
