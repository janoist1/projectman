import fs from 'node:fs';
import path from 'node:path';
import {
  CLIENT_CONFIG_RELATIVE_PATH,
  ClientAccessHeaders,
  ClientConfig,
  ClientKeyText,
} from '@projectman/shared';
import { ClientFileError, currentOwner, readPrivateFile, type FileOwner } from './files';

/** A problem with the configuration or a credential file; the client answers it as an authentication failure (3). */
export class ClientConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ClientConfigError';
  }
}

export interface ClientCredentials {
  /** The server's origin, without a path. */
  baseUrl: URL;
  /** The bearer secret. Only the HTTP layer puts it into a request. */
  key: string;
  /** The Cloudflare Access headers, or empty. Only the HTTP layer puts them into a request. */
  accessHeaders: Record<string, string>;
  /** Every secret value, for the redaction of text that is written out. */
  secrets: string[];
  /** The configuration and credential files themselves, as the file system names them. */
  credentialFiles: string[];
  /** The directories that hold them: nothing in them is sent as the user's text. */
  protectedDirectories: string[];
}

interface LoadOptions {
  home: string;
  /** `--config`; the default is `~/.config/projectman/client.json`. */
  configFile?: string | undefined;
  owner?: FileOwner;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** HTTPS, or HTTP to this machine: the key is never sent in clear over a network. */
export function parseBaseUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ClientConfigError('config_base_url', 'baseUrl is not a URL');
  }
  if (url.username || url.password)
    throw new ClientConfigError('config_base_url', 'baseUrl must not carry a user name or a password');
  if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
    throw new ClientConfigError(
      'config_base_url',
      'baseUrl must be an origin only (no path, query or fragment)',
    );
  const loopback = LOOPBACK_HOSTS.has(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && loopback) return url;
  throw new ClientConfigError(
    'config_base_url',
    'baseUrl must be https, or http to this machine (localhost)',
  );
}

function resolveFrom(base: string, home: string, target: string): string {
  if (target === '~') return home;
  if (target.startsWith('~/')) return path.join(home, target.slice(2));
  return path.isAbsolute(target) ? target : path.resolve(base, target);
}

function realOrSelf(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function read(file: string, owner: FileOwner): string {
  try {
    return readPrivateFile(file, owner);
  } catch (error) {
    if (error instanceof ClientFileError) throw new ClientConfigError(error.code, error.message);
    throw error;
  }
}

/** Reads the configuration and the files it names, after the file checks; no environment variable is read. */
export function loadCredentials(options: LoadOptions): ClientCredentials {
  const owner = options.owner ?? currentOwner();
  const configFile = path.resolve(options.configFile ?? path.join(options.home, CLIENT_CONFIG_RELATIVE_PATH));
  const configDir = path.dirname(configFile);
  let json: unknown;
  try {
    json = JSON.parse(read(configFile, owner));
  } catch (error) {
    if (error instanceof ClientConfigError) throw error;
    throw new ClientConfigError('config_invalid', `the configuration ${configFile} is not valid JSON`);
  }
  const parsed = ClientConfig.safeParse(json);
  if (!parsed.success)
    throw new ClientConfigError(
      'config_invalid',
      `the configuration ${configFile} is not valid: ${parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')}`,
    );
  const config = parsed.data;
  const baseUrl = parseBaseUrl(config.baseUrl);

  const keyFile = resolveFrom(configDir, options.home, config.keyFile);
  const key = read(keyFile, owner).trim();
  if (!ClientKeyText.safeParse(key).success)
    throw new ClientConfigError('key_invalid', `the key file ${keyFile} does not hold an integrator key`);

  const files = [configFile, keyFile];
  const directories = [configDir, path.dirname(keyFile)];
  const accessHeaders: Record<string, string> = {};
  const secrets = [key];
  if (config.accessHeadersFile) {
    const accessFile = resolveFrom(configDir, options.home, config.accessHeadersFile);
    let access: unknown;
    try {
      access = JSON.parse(read(accessFile, owner));
    } catch (error) {
      if (error instanceof ClientConfigError) throw error;
      throw new ClientConfigError('access_invalid', `the Access file ${accessFile} is not valid JSON`);
    }
    const headers = ClientAccessHeaders.safeParse(access);
    if (!headers.success)
      throw new ClientConfigError(
        'access_invalid',
        `the Access file ${accessFile} lacks the service token headers`,
      );
    accessHeaders['CF-Access-Client-Id'] = headers.data['CF-Access-Client-Id'];
    accessHeaders['CF-Access-Client-Secret'] = headers.data['CF-Access-Client-Secret'];
    secrets.push(...Object.values(accessHeaders));
    files.push(accessFile);
    directories.push(path.dirname(accessFile));
  }
  return {
    baseUrl,
    key,
    accessHeaders,
    secrets,
    credentialFiles: files.map(realOrSelf),
    protectedDirectories: [...new Set(directories.map(realOrSelf))],
  };
}
