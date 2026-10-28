import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { isAbsolute, join, resolve, sep, relative } from 'node:path';
import type { Finding } from './inventory';

/** Shared helpers and the manifest for the hybrid cloud package (PM-318). */
export const PACKAGE_VERSION = 1;

export interface PackageManifest {
  version: typeof PACKAGE_VERSION;
  kind: 'hybrid_cloud';
  /** A `hybrid_cloud` package: the engine its database was prepared for (no key; the cloud keeps the hash). */
  engine?: { id: string; name: string };
  createdAt: string;
  sourceHome: string;
  sourcePlatform: string;
  sourceSchemaVersion: number;
  buildSchemaVersion: number;
  repos: never[];
  work: never[];
  transcripts: never[];
  /** Entries of the source home that were left out on purpose, with their sizes. */
  notCarried: { name: string; bytes: number }[];
  files: Record<string, { sha256: string; bytes: number }>;
}

export class MigrationRefused extends Error {
  readonly findings: Finding[];
  constructor(message: string, findings: Finding[] = []) {
    super(message);
    this.name = 'MigrationRefused';
    this.findings = findings;
  }
}

/** The checksum of a file; of a symbolic link, the checksum of where it points (a dangling link is no error). */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  if (lstatSync(path).isSymbolicLink()) {
    hash.update(`link:${readlinkSync(path)}`);
    return hash.digest('hex');
  }
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function walkFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isDirectory()) stack.push(path);
      else files.push(path);
    }
  }
  return files.sort();
}

export function assertSafeOutput(home: string, out: string): void {
  const resolved = resolve(out);
  if (resolved === home || resolved.startsWith(home + sep))
    throw new MigrationRefused(`the package must not be inside the source home (${home})`);
  if (existsSync(resolved) && readdirSync(resolved).length > 0)
    throw new MigrationRefused(`${resolved} exists and is not empty`);
}

/** Reads and checks a package: every listed file must be there with its checksum, and no other file may be. */
export async function readPackage(dir: string): Promise<PackageManifest> {
  const root = resolve(dir);
  const manifestPath = join(root, 'manifest.json');
  if (!existsSync(manifestPath))
    throw new MigrationRefused(`${root} has no manifest.json: not a migration package`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
  if (manifest.version !== PACKAGE_VERSION)
    throw new MigrationRefused(`unsupported package version ${String(manifest.version)}`);
  if (manifest.kind !== 'hybrid_cloud')
    throw new MigrationRefused(`unsupported package kind ${JSON.stringify(manifest.kind)}`);
  // The manifest is read from a file that was carried: no file may name a place outside the package.
  const safe = (name: unknown, what: string): string => {
    if (
      typeof name !== 'string' ||
      name === '' ||
      name.includes('\0') ||
      name.includes('\\') ||
      isAbsolute(name) ||
      name.split('/').some((part) => part === '' || part === '.' || part === '..')
    )
      throw new MigrationRefused(`the manifest names an unsafe ${what}: ${JSON.stringify(name)}`);
    return name;
  };
  for (const name of Object.keys(manifest.files)) safe(name, 'file');
  const seen = new Set<string>();
  for (const [name, expected] of Object.entries(manifest.files)) {
    const path = join(root, name);
    // lstat, not exists: a symbolic link that points nowhere is still a file of the package.
    if (!lstatSync(path, { throwIfNoEntry: false })) throw new MigrationRefused(`the package lacks ${name}`);
    if ((await sha256File(path)) !== expected.sha256)
      throw new MigrationRefused(`${name} does not match its checksum`);
    seen.add(name);
  }
  for (const path of walkFiles(root)) {
    const name = relative(root, path).split(sep).join('/');
    if (name !== 'manifest.json' && !seen.has(name))
      throw new MigrationRefused(`${name} is in the package but not in its manifest`);
  }
  return manifest;
}
