import fs from 'node:fs';
import path from 'node:path';
import { ClientAccessHeaders, ClientKeyText, CLIENT_CONFIG_RELATIVE_PATH } from '@projectman/shared';
import { parseBaseUrl, ClientConfigError } from './config';
import { UsageError, type CommandContext } from './context';
import {
  ClientFileError,
  currentOwner,
  readCredentialFile,
  readInputFile,
  readStream,
  writeFileAtomic,
} from './files';

/**
 * `projectman connect` (PM-1429): writes the client's credential files from what the user hands it, so a
 * machine without a checkout can start `mcp-proxy`. The key is read from standard input only; neither it nor the
 * Access values reach an argument, the environment or the output, and no message names them.
 */

const KEY_FILE = 'integrator-key';
const ACCESS_FILE = 'cloud/integrator-access-token.json';

function fail(code: string, message: string): never {
  throw new ClientFileError(code, message);
}

interface Target {
  file: string;
  text: string;
}

/** What the target holds now: null when it does not exist; a link, another user's or a non-regular file is refused. */
function currentText(file: string): string | null {
  return readCredentialFile(file, { allowMissing: true });
}

/** A real directory of the user with mode 0700, made when it is missing; a link is never followed. */
function ensurePrivateDirectory(dir: string): void {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      fail('credential_directory_invalid', `the directory ${dir} cannot be inspected`);
  }
  if (!stat) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    return;
  }
  if (stat.isSymbolicLink()) fail('credential_symlink', `the directory ${dir} is a symbolic link`);
  if (!stat.isDirectory()) fail('credential_directory_invalid', `${dir} is not a directory`);
  const owner = currentOwner();
  if (owner.uid !== null && stat.uid !== owner.uid)
    fail('credential_owner', `the directory ${dir} is not owned by the current user`);
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

/**
 * Checks the directory itself (its ancestors are not inspected) before any write: when it exists, it must not be a
 * link, must be a directory and must belong to the current user. A missing directory passes; it is made later.
 */
function assertDirectoryUsable(dir: string): void {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) fail('credential_symlink', `the directory ${dir} is a symbolic link`);
  if (!stat.isDirectory()) fail('credential_directory_invalid', `${dir} is not a directory`);
  const owner = currentOwner();
  if (owner.uid !== null && stat.uid !== owner.uid)
    fail('credential_owner', `the directory ${dir} is not owned by the current user`);
}

function text(ctx: CommandContext, name: string): string | undefined {
  const value = ctx.values[name];
  if (Array.isArray(value)) throw new UsageError(`--${name} can be given only once`);
  return typeof value === 'string' ? value : undefined;
}

/**
 * The client's own copy of an Access headers file (only the two service token headers), read from the user's file.
 * A missing, unreadable or malformed file fails with `access_headers_invalid` or the file rule's own code.
 */
export function readAccessHeadersText(file: string): string {
  const raw = readInputFile(file, []);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('access_headers_invalid', 'the Access headers file is not valid JSON');
  }
  const headers = ClientAccessHeaders.safeParse(parsed);
  if (!headers.success)
    fail('access_headers_invalid', 'the Access headers file lacks the service token headers');
  return `${JSON.stringify({
    'CF-Access-Client-Id': headers.data['CF-Access-Client-Id'],
    'CF-Access-Client-Secret': headers.data['CF-Access-Client-Secret'],
  })}\n`;
}

/** What `connect` writes: the key, the hub's origin and the normalised Access headers, under the user's home. */
export interface ClientCredentials {
  home: string;
  origin: string;
  key: string;
  accessText?: string;
}

/** The checked plan of a client credential write; `writeClientCredentials` carries it out. */
export interface PreparedClientCredentials {
  configDir: string;
  cloudDir: string | null;
  changes: Target[];
  unchanged: string[];
}

/**
 * Checks every target before anything is written, so a refusal leaves the old setup whole: a link, another user's
 * or a non-regular file is refused, and a file with other content needs `replace` (`connect_file_exists`).
 */
export function prepareClientCredentials(
  credentials: ClientCredentials,
  replace: boolean,
): PreparedClientCredentials {
  const { home, origin, key, accessText } = credentials;
  const configFile = path.join(home, CLIENT_CONFIG_RELATIVE_PATH);
  const configDir = path.dirname(configFile);
  const cloudDir = path.join(configDir, 'cloud');
  const targets: Target[] = [
    { file: path.join(configDir, KEY_FILE), text: `${key}\n` },
    ...(accessText === undefined ? [] : [{ file: path.join(configDir, ACCESS_FILE), text: accessText }]),
    {
      file: configFile,
      text: `${JSON.stringify(
        {
          version: 1,
          baseUrl: origin,
          keyFile: `~/${path.dirname(CLIENT_CONFIG_RELATIVE_PATH)}/${KEY_FILE}`,
          ...(accessText === undefined ? {} : { accessHeadersFile: ACCESS_FILE }),
        },
        null,
        2,
      )}\n`,
    },
  ];

  assertDirectoryUsable(configDir);
  if (accessText !== undefined) assertDirectoryUsable(cloudDir);
  const changes: Target[] = [];
  const unchanged: string[] = [];
  for (const target of targets) {
    const existing = currentText(target.file);
    if (existing === target.text) unchanged.push(target.file);
    else if (existing === null || replace) changes.push(target);
    else
      fail(
        'connect_file_exists',
        `the file ${target.file} exists with other content; run again with --replace to overwrite it`,
      );
  }
  return { configDir, cloudDir: accessText === undefined ? null : cloudDir, changes, unchanged };
}

/** Writes a checked plan: files 0600 in directories 0700, never through a link. Returns the paths it wrote. */
export function writeClientCredentials(prepared: PreparedClientCredentials): {
  written: string[];
  unchanged: string[];
} {
  const { configDir, cloudDir, changes, unchanged } = prepared;
  ensurePrivateDirectory(configDir);
  if (cloudDir !== null) ensurePrivateDirectory(cloudDir);
  for (const target of changes) {
    writeFileAtomic(target.file, target.text, 0o600);
    fs.chmodSync(target.file, 0o600);
  }
  // An identical file may carry a wider mode from an earlier hand-made setup; the client refuses such a file.
  for (const file of unchanged) fs.chmodSync(file, 0o600);
  return { written: changes.map((target) => target.file), unchanged };
}

/** The path of the client's key file under the user's home. */
export const clientKeyFile = (home: string): string =>
  path.join(home, path.dirname(CLIENT_CONFIG_RELATIVE_PATH), KEY_FILE);

export async function runConnect(ctx: CommandContext): Promise<number> {
  const baseUrlText = text(ctx, 'base-url');
  if (baseUrlText === undefined || baseUrlText === '') throw new UsageError('--base-url is required');
  const accessSource = text(ctx, 'access-headers-file');
  const replace = ctx.values.replace === true;
  // A terminal would show the typed key on the screen (and in its scrollback); the key must come through a pipe.
  if (ctx.io.stdinIsTerminal)
    throw new UsageError(
      'standard input is a terminal: pipe the key in (for example `pbpaste | projectman connect ...`)',
    );

  let origin: string;
  try {
    origin = parseBaseUrl(baseUrlText).origin;
  } catch (error) {
    if (error instanceof ClientConfigError) throw new UsageError(`--base-url: ${error.message}`);
    throw error;
  }

  let accessText: string | undefined;
  if (accessSource !== undefined) {
    try {
      accessText = readAccessHeadersText(accessSource);
    } catch (error) {
      if (error instanceof ClientFileError) throw new UsageError(error.message);
      throw error;
    }
  }

  const key = (await readStream(ctx.io.stdin, ctx.io.signal)).trim();
  if (!ClientKeyText.safeParse(key).success)
    throw new UsageError('standard input does not hold an integrator key');

  const { written, unchanged } = writeClientCredentials(
    prepareClientCredentials(
      { home: ctx.io.home, origin, key, ...(accessText === undefined ? {} : { accessText }) },
      replace,
    ),
  );
  if (ctx.json) await ctx.print(`${JSON.stringify({ written, unchanged })}\n`);
  else
    await ctx.print(
      `${[
        ...written.map((file) => `wrote ${file}`),
        ...unchanged.map((file) => `unchanged ${file}`),
        'next: projectman check',
      ].join('\n')}\n`,
    );
  return 0;
}
