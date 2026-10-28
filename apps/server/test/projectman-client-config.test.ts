import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClientAccessHeaders, ClientConfig, ClientKeyText } from '@projectman/shared';
import { ClientConfigError, loadCredentials, parseBaseUrl } from '../../../scripts/projectman/config';
import {
  ClientFileError,
  readInputFile,
  readPrivateFile,
  writeFileAtomic,
} from '../../../scripts/projectman/files';
import { redact } from '../../../scripts/projectman/redact';
import {
  CANARY_ACCESS_ID,
  CANARY_ACCESS_SECRET,
  CANARY_KEY,
  createClientHome,
  type ClientHome,
} from './helpers/projectman-client';

describe('projectman client configuration (PM-765)', () => {
  let fx: ClientHome;
  beforeEach(() => {
    fx = createClientHome({ access: true });
  });
  afterEach(() => fx.cleanup());

  const load = (extra: { configFile?: string; owner?: { uid: number | null } } = {}) =>
    loadCredentials({ home: fx.home, ...extra });
  const codeOf = (action: () => unknown): string => {
    try {
      action();
    } catch (error) {
      if (error instanceof ClientConfigError || error instanceof ClientFileError) return error.code;
      throw error;
    }
    return 'no error';
  };
  const rewriteConfig = (patch: Record<string, unknown>) => {
    const current = JSON.parse(fs.readFileSync(fx.configFile, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(fx.configFile, JSON.stringify({ ...current, ...patch }));
    fs.chmodSync(fx.configFile, 0o600);
  };

  it('loads the key and the Access headers from the files the configuration names', () => {
    const credentials = load();
    expect(credentials.baseUrl.origin).toBe('https://pm.example.com');
    expect(credentials.key).toBe(CANARY_KEY);
    expect(credentials.accessHeaders).toEqual({
      'CF-Access-Client-Id': CANARY_ACCESS_ID,
      'CF-Access-Client-Secret': CANARY_ACCESS_SECRET,
    });
    expect(credentials.secrets).toEqual([CANARY_KEY, CANARY_ACCESS_ID, CANARY_ACCESS_SECRET]);
    expect(credentials.credentialFiles).toEqual([fx.configFile, fx.keyFile, fx.accessFile]);
  });

  it('works without Access headers', () => {
    fs.rmSync(fx.accessFile);
    rewriteConfig({ accessHeadersFile: undefined });
    expect(load().accessHeaders).toEqual({});
  });

  it('refuses a file that is not mode 0600 and a directory that is not 0700', () => {
    fs.chmodSync(fx.keyFile, 0o640);
    expect(codeOf(load)).toBe('credential_mode');
    fs.chmodSync(fx.keyFile, 0o600);
    fs.chmodSync(fx.configFile, 0o644);
    expect(codeOf(load)).toBe('credential_mode');
    fs.chmodSync(fx.configFile, 0o600);
    fs.chmodSync(fx.configDir, 0o755);
    expect(codeOf(load)).toBe('credential_mode');
    fs.chmodSync(fx.configDir, 0o700);
    expect(codeOf(load)).toBe('no error');
  });

  it('refuses a symbolic link as the key file, the Access file, the configuration or the directory', () => {
    const real = path.join(fx.home, 'real-key');
    fs.writeFileSync(real, `${CANARY_KEY}\n`, { mode: 0o600 });
    fs.rmSync(fx.keyFile);
    fs.symlinkSync(real, fx.keyFile);
    expect(codeOf(load)).toBe('credential_symlink');

    fs.rmSync(fx.keyFile);
    fs.writeFileSync(fx.keyFile, `${CANARY_KEY}\n`, { mode: 0o600 });
    const realAccess = path.join(fx.home, 'real-access');
    fs.renameSync(fx.accessFile, realAccess);
    fs.symlinkSync(realAccess, fx.accessFile);
    expect(codeOf(load)).toBe('credential_symlink');
    fs.rmSync(fx.accessFile);
    fs.renameSync(realAccess, fx.accessFile);

    const elsewhere = path.join(fx.home, 'elsewhere.json');
    fs.copyFileSync(fx.configFile, elsewhere);
    fs.chmodSync(elsewhere, 0o600);
    const linkedConfig = path.join(fx.configDir, 'linked.json');
    fs.symlinkSync(elsewhere, linkedConfig);
    expect(codeOf(() => load({ configFile: linkedConfig }))).toBe('credential_symlink');

    const linkedDirectory = path.join(fx.home, 'linked-dir');
    fs.symlinkSync(fx.configDir, linkedDirectory);
    expect(codeOf(() => load({ configFile: path.join(linkedDirectory, 'client.json') }))).toBe(
      'credential_symlink',
    );
  });

  it('refuses files and directories that belong to another user', () => {
    const stranger = { uid: (process.getuid?.() ?? 0) + 1 };
    expect(codeOf(() => load({ owner: stranger }))).toBe('credential_owner');
    expect(codeOf(() => readPrivateFile(fx.keyFile, stranger))).toBe('credential_owner');
  });

  it('refuses something that is not a regular file and a missing file', () => {
    fs.rmSync(fx.keyFile);
    fs.mkdirSync(fx.keyFile, { mode: 0o600 });
    expect(codeOf(load)).toBe('credential_file_invalid');
    fs.rmSync(fx.keyFile, { recursive: true });
    expect(codeOf(load)).toBe('credential_file_missing');
  });

  it('validates the key text, the configuration shape and the Access file', () => {
    fs.writeFileSync(fx.keyFile, 'not-a-key\n');
    expect(codeOf(load)).toBe('key_invalid');
    fs.writeFileSync(fx.keyFile, `${CANARY_KEY}\n`);
    rewriteConfig({ extra: true });
    expect(codeOf(load)).toBe('config_invalid');
    rewriteConfig({ extra: undefined, version: 2 });
    expect(codeOf(load)).toBe('config_invalid');
    fs.writeFileSync(fx.configFile, '{ not json');
    expect(codeOf(load)).toBe('config_invalid');
    fs.writeFileSync(
      fx.configFile,
      JSON.stringify({
        version: 1,
        baseUrl: 'https://pm.example.com',
        keyFile: 'integrator-key',
        accessHeadersFile: 'integrator-access-token.json',
      }),
    );
    fs.writeFileSync(fx.accessFile, JSON.stringify({ 'CF-Access-Client-Id': 'x' }));
    expect(codeOf(load)).toBe('access_invalid');
  });

  it('never puts the content of a bad credential file into an error', () => {
    fs.writeFileSync(fx.keyFile, `${CANARY_ACCESS_SECRET}\n`);
    try {
      load();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(CANARY_ACCESS_SECRET);
      return;
    }
    throw new Error('expected a failure');
  });

  it('accepts HTTPS and loopback HTTP origins only, without credentials, path or redirect surprises', () => {
    expect(parseBaseUrl('https://pm.example.com').origin).toBe('https://pm.example.com');
    expect(parseBaseUrl('https://pm.example.com/').origin).toBe('https://pm.example.com');
    expect(parseBaseUrl('http://127.0.0.1:4800').origin).toBe('http://127.0.0.1:4800');
    expect(parseBaseUrl('http://localhost:4800').origin).toBe('http://localhost:4800');
    expect(parseBaseUrl('http://[::1]:4800').origin).toBe('http://[::1]:4800');
    for (const bad of [
      'http://pm.example.com',
      'http://192.168.1.4:4800',
      'http://127.0.0.1.example.com',
      'ftp://pm.example.com',
      'https://user:pass@pm.example.com',
      'https://pm.example.com/base',
      'https://pm.example.com/?x=1',
      'https://pm.example.com/#x',
      'pm.example.com',
    ])
      expect(
        codeOf(() => parseBaseUrl(bad)),
        bad,
      ).toBe('config_base_url');
  });

  it('has no token argument and no environment fallback: the environment is not read', () => {
    const before = { ...process.env };
    process.env.PROJECTMAN_INTEGRATOR_KEY = 'pmi_FROMENVIRONMENT';
    process.env.PROJECTMAN_TOKEN = 'pmi_FROMENVIRONMENT';
    try {
      expect(load().key).toBe(CANARY_KEY);
      fs.rmSync(fx.keyFile);
      expect(codeOf(load)).toBe('credential_file_missing');
    } finally {
      process.env = before;
    }
  });

  it('keeps the shared schemas strict about the configuration and lenient about Access extras', () => {
    expect(ClientConfig.safeParse({ version: 1, baseUrl: 'https://x.example', keyFile: 'k' }).success).toBe(
      true,
    );
    expect(
      ClientConfig.safeParse({ version: 1, baseUrl: 'https://x.example', keyFile: 'k', token: 'pmi_x' })
        .success,
    ).toBe(false);
    expect(ClientKeyText.safeParse('pmi_abc-DEF_123').success).toBe(true);
    expect(ClientKeyText.safeParse('pmi_abc def').success).toBe(false);
    expect(
      ClientAccessHeaders.safeParse({ 'CF-Access-Client-Id': 'a', 'CF-Access-Client-Secret': 'b', extra: 1 })
        .success,
    ).toBe(true);
  });
});

describe('projectman client input files (PM-765)', () => {
  let fx: ClientHome;
  beforeEach(() => {
    fx = createClientHome({ access: true });
  });
  afterEach(() => fx.cleanup());
  const codeOf = (action: () => unknown): string => {
    try {
      action();
    } catch (error) {
      if (error instanceof ClientFileError) return error.code;
      throw error;
    }
    return 'no error';
  };

  it('reads a regular file, with multiline text intact', () => {
    const file = path.join(fx.home, 'message.txt');
    fs.writeFileSync(file, 'first line\n\n  second line\n');
    expect(readInputFile(file, [])).toBe('first line\n\n  second line\n');
  });

  it('refuses a symbolic link, a directory, a missing file and a too large file', () => {
    const file = path.join(fx.home, 'message.txt');
    fs.writeFileSync(file, 'text');
    const link = path.join(fx.home, 'link.txt');
    fs.symlinkSync(file, link);
    expect(codeOf(() => readInputFile(link, []))).toBe('input_file_symlink');
    expect(codeOf(() => readInputFile(fx.home, []))).toBe('input_file_invalid');
    expect(codeOf(() => readInputFile(path.join(fx.home, 'missing'), []))).toBe('input_file_missing');
    fs.writeFileSync(path.join(fx.home, 'big.txt'), Buffer.alloc(1024 * 1024 + 1, 97));
    expect(codeOf(() => readInputFile(path.join(fx.home, 'big.txt'), []))).toBe('input_file_too_large');
  });

  it('never sends a credential file, the configuration or anything in their directory', () => {
    const protectedPaths = [fx.keyFile, fx.configFile, fx.accessFile, fx.configDir];
    expect(codeOf(() => readInputFile(fx.keyFile, protectedPaths))).toBe('input_file_protected');
    expect(codeOf(() => readInputFile(fx.accessFile, protectedPaths))).toBe('input_file_protected');
    fs.writeFileSync(path.join(fx.configDir, 'notes.txt'), 'text');
    expect(codeOf(() => readInputFile(path.join(fx.configDir, 'notes.txt'), protectedPaths))).toBe(
      'input_file_protected',
    );
    // A relative spelling of the same file is the same file.
    expect(codeOf(() => readInputFile(path.relative(process.cwd(), fx.keyFile), protectedPaths))).toBe(
      'input_file_protected',
    );
  });

  it('writes a file in one step with the private mode', () => {
    const file = path.join(fx.home, 'cursor');
    writeFileAtomic(file, 'a\n');
    writeFileAtomic(file, 'b\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('b\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(fx.home).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('projectman client redaction (PM-765)', () => {
  it('takes out the exact secrets, any pmi_ key, bearer values and Access header values', () => {
    const text = [
      `key ${CANARY_KEY}`,
      'other pmi_someOtherKey123',
      'Authorization: Bearer abcdef.ghi',
      `CF-Access-Client-Secret: ${CANARY_ACCESS_SECRET}`,
      'cf-access-client-id=hidden-id.access',
      `secret ${CANARY_ACCESS_ID}`,
    ].join('\n');
    const clean = redact(text, [CANARY_KEY, CANARY_ACCESS_ID, CANARY_ACCESS_SECRET]);
    for (const leaked of [
      CANARY_KEY,
      'pmi_someOtherKey123',
      'abcdef.ghi',
      CANARY_ACCESS_SECRET,
      'hidden-id.access',
      CANARY_ACCESS_ID,
    ])
      expect(clean).not.toContain(leaked);
    expect(clean).toContain('[redacted]');
  });
});
