import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Report } from '../../../scripts/cloud/report';
import {
  checkSecretsDir,
  ensureSecretsDir,
  inspectSecrets,
  newResticPassword,
  readEnvFile,
  readSecret,
  secretsDir,
  updateEnvFile,
  writeSecret,
} from '../../../scripts/cloud/secrets';

/** The secrets store of the cloud commands (PM-534). */

let home: string;
let dir: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cloud-secrets-')));
  dir = secretsDir(home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const mode = (file: string) => statSync(file).mode & 0o777;

describe('the directory', () => {
  it('is ~/.config/projectman/cloud, created with mode 700', () => {
    expect(dir).toBe(path.join(home, '.config', 'projectman', 'cloud'));
    ensureSecretsDir(dir);
    expect(mode(dir)).toBe(0o700);
  });

  it('is fine when it is missing, and refused when others can enter it', () => {
    expect(() => checkSecretsDir(dir)).not.toThrow();
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    expect(() => checkSecretsDir(dir)).toThrow(/mode 755; it must be 700/);
    chmodSync(dir, 0o710);
    expect(() => checkSecretsDir(dir)).toThrow(/must be 700/);
    chmodSync(dir, 0o700);
    expect(() => checkSecretsDir(dir)).not.toThrow();
  });

  it('is refused when it is a symbolic link', () => {
    const real = path.join(home, 'real');
    mkdirSync(real, { mode: 0o700 });
    mkdirSync(path.dirname(dir), { recursive: true });
    symlinkSync(real, dir);
    expect(() => checkSecretsDir(dir)).toThrow(/symbolic link/);
  });
});

describe('a secret file', () => {
  it('is written with mode 600 through a temporary file that does not stay', () => {
    const file = writeSecret(dir, 'cloud.env', 'A=1\n');
    expect(file).toBe(path.join(dir, 'cloud.env'));
    expect(mode(file)).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['cloud.env']);
    writeSecret(dir, 'cloud.env', 'A=2\n');
    expect(readFileSync(file, 'utf8')).toBe('A=2\n');
    expect(mode(file)).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['cloud.env']);
  });

  it('reads as null when it is missing', () => {
    expect(readSecret(path.join(dir, 'nothing'))).toBeNull();
  });

  it('is refused when it has a wider mode than 600, but 400 is allowed', () => {
    const file = writeSecret(dir, 'cloudflare-token', 'token');
    for (const wide of [0o644, 0o640, 0o604, 0o700]) {
      chmodSync(file, wide);
      expect(() => readSecret(file)).toThrow(/must be 600/);
      expect(() => writeSecret(dir, 'cloudflare-token', 'x')).toThrow(/must be 600/);
    }
    chmodSync(file, 0o400);
    expect(readSecret(file)).toBe('token');
  });

  it('is refused when it is a symbolic link, and a write does not follow it', () => {
    ensureSecretsDir(dir);
    const target = path.join(home, 'elsewhere');
    writeFileSync(target, 'precious', { mode: 0o600 });
    const link = path.join(dir, 'cloud.env');
    symlinkSync(target, link);
    expect(() => readSecret(link)).toThrow(/symbolic link/);
    expect(() => writeSecret(dir, 'cloud.env', 'A=1\n')).toThrow(/symbolic link/);
    expect(readFileSync(target, 'utf8')).toBe('precious');
  });

  it('is listed as a problem by the inspection', () => {
    const file = writeSecret(dir, 'cloud.env', 'A=1\n');
    expect(inspectSecrets(dir, [file, path.join(dir, 'missing')])).toEqual([]);
    chmodSync(file, 0o666);
    chmodSync(dir, 0o777);
    expect(inspectSecrets(dir, [file])).toHaveLength(2);
  });
});

describe('the env file', () => {
  const file = () => path.join(dir, 'cloud.env');

  it('is empty when it does not exist', () => {
    expect(readEnvFile(file()).size).toBe(0);
  });

  it('is written as NAME=value lines without quotes, with mode 600', () => {
    expect(updateEnvFile(file(), { A: '1', B: 'two words', C: 'a=b' })).toEqual(['A', 'B', 'C']);
    expect(readFileSync(file(), 'utf8')).toBe('A=1\nB=two words\nC=a=b\n');
    expect(mode(file())).toBe(0o600);
    expect(Object.fromEntries(readEnvFile(file()))).toEqual({ A: '1', B: 'two words', C: 'a=b' });
  });

  it('sets one key and keeps the other lines, the comments and the order', () => {
    writeSecret(dir, 'cloud.env', '# keep me\nA=1\n\nB=2\nTUNNEL_TOKEN=abc\n');
    expect(updateEnvFile(file(), { B: '3', NEW: 'x' })).toEqual(['B', 'NEW']);
    expect(readFileSync(file(), 'utf8')).toBe('# keep me\nA=1\n\nB=3\nTUNNEL_TOKEN=abc\nNEW=x\n');
  });

  it('writes nothing when no value changes', () => {
    writeSecret(dir, 'cloud.env', 'A=1\n');
    const before = statSync(file()).mtimeMs;
    expect(updateEnvFile(file(), { A: '1' })).toEqual([]);
    expect(statSync(file()).mtimeMs).toBe(before);
  });

  it('merges a repeated name into its first place', () => {
    writeSecret(dir, 'cloud.env', 'A=1\nB=2\nA=3\n');
    updateEnvFile(file(), { A: '9' });
    expect(readFileSync(file(), 'utf8')).toBe('A=9\nB=2\n');
  });

  it('refuses a name or a value that would break the format, and a file that is not NAME=value', () => {
    expect(() => updateEnvFile(file(), { 'bad name': '1' })).toThrow(/not a valid env-file name/);
    expect(() => updateEnvFile(file(), { A: 'line\nbreak' })).toThrow(/line break/);
    expect(existsSync(file())).toBe(false);
    writeSecret(dir, 'cloud.env', 'this is not an env line\n');
    expect(() => readEnvFile(file())).toThrow(/NAME=value/);
  });

  it('refuses to read or write a file with a wide mode', () => {
    writeSecret(dir, 'cloud.env', 'A=1\n');
    chmodSync(file(), 0o644);
    expect(() => readEnvFile(file())).toThrow(/must be 600/);
    expect(() => updateEnvFile(file(), { A: '2' })).toThrow(/must be 600/);
  });
});

describe('the generated password and the report', () => {
  it('is 32 random bytes in base64url', () => {
    const first = newResticPassword();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newResticPassword()).not.toBe(first);
  });

  it('masks a protected secret in every line, and leaves short values alone', () => {
    const lines: string[] = [];
    const report = new Report((line) => lines.push(line));
    report.protect('s3cr3t-value-123');
    report.protect('tiny');
    report.step('ok', 'step', 'the value s3cr3t-value-123 and tiny');
    expect(lines).toEqual(['ok step: the value *** and tiny']);
  });
});
