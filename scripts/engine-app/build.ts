import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { EnginePackageManifest } from '../../apps/server/src/contracts';
import type { CloudDeps, RunOptions } from '../cloud/deps';
import { CloudError, refused } from '../cloud/errors';
import { bundleVersions, EngineAppManifest } from './manifest';

export interface EngineAppBuildRequest {
  packageDir: string;
  outDir: string;
  sourceRepo: string;
  originUrl: string;
  adHoc: boolean;
  identity?: string;
  teamId?: string;
  notaryProfile?: string;
}

const NOTARY_TIMEOUT = 30 * 60 * 1000;
const MACH_MAGICS = new Set([
  'feedface',
  'cefaedfe',
  'feedfacf',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca',
]);
export function isMachO(header: Buffer): boolean {
  return header.length >= 4 && MACH_MAGICS.has(header.subarray(0, 4).toString('hex'));
}

/** Do not follow symlinks: workspace links point at files already visited in the package tree. */
function binaries(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return binaries(file);
      if (!entry.isFile()) return [];
      const fd = fs.openSync(file, 'r');
      try {
        const header = Buffer.alloc(4);
        return isMachO(header.subarray(0, fs.readSync(fd, header, 0, 4, 0))) ? [file] : [];
      } finally {
        fs.closeSync(fd);
      }
    });
}

function releaseRepo(origin: string): string {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(origin);
  if (!match) throw refused('origin must name a GitHub owner/repository');
  return match[1]!;
}
const xml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );

/** All build products and tool caches stay under outDir; an existing nonempty output is refused. */
export async function buildEngineApp(
  deps: Pick<CloudDeps, 'run'> & { platform: NodeJS.Platform },
  request: EngineAppBuildRequest,
  signal?: AbortSignal,
): Promise<{ root: string }> {
  if (deps.platform !== 'darwin') throw refused('the engine app requires a macOS release machine');
  if (
    !request.adHoc &&
    (!request.identity?.trim() ||
      !/^[A-Z0-9]{10}$/.test(request.teamId ?? '') ||
      !request.notaryProfile?.trim())
  )
    throw refused('signed builds require --identity, --team-id and --notary-profile (keychain names only)');
  const pkg = path.resolve(request.packageDir);
  const out = path.resolve(request.outDir);
  if (out === pkg || out.startsWith(pkg + path.sep) || pkg.startsWith(out + path.sep))
    throw refused('package and output directories must not overlap');
  if (
    fs.existsSync(out) &&
    (!fs.lstatSync(out).isDirectory() || fs.lstatSync(out).isSymbolicLink() || fs.readdirSync(out).length)
  )
    throw refused('the output directory must be absent or empty');
  const manifest = EnginePackageManifest.parse(
    JSON.parse(fs.readFileSync(path.join(pkg, 'engine-package.json'), 'utf8')),
  );
  const versions = bundleVersions(manifest.tag);
  const repo = releaseRepo(request.originUrl);
  const teamId = request.adHoc ? '' : request.teamId!;
  fs.mkdirSync(out, { recursive: true });
  const work = fs.mkdtempSync(path.join(out, '.build-'));
  const temp = path.join(work, 'tmp');
  fs.mkdirSync(temp);
  const toolEnv = { TMPDIR: temp };
  const app = path.join(out, 'projectman motor.app');
  const zip = path.join(out, 'projectman-motor.zip');
  const dmg = path.join(out, 'projectman-motor.dmg');
  const checked = async (command: string, args: string[], options: RunOptions = {}) => {
    signal?.throwIfAborted();
    const result = await deps.run(command, args, { ...options, env: { ...toolEnv, ...options.env }, signal });
    if (result.code !== 0)
      throw new CloudError(
        `${command} failed (${result.code}): ${(result.stderr || result.stdout).slice(-4000)}`,
      );
    return result.stdout.trim();
  };
  const sign = (file: string, entitlements?: string) =>
    checked('codesign', [
      '--force',
      ...(request.adHoc ? [] : ['--timestamp', '--options', 'runtime']),
      '--sign',
      request.adHoc ? '-' : request.identity!,
      ...(entitlements ? ['--entitlements', entitlements] : []),
      file,
    ]);
  const notarize = async (file: string, name: string) => {
    const result = await deps.run(
      'xcrun',
      [
        'notarytool',
        'submit',
        file,
        '--keychain-profile',
        request.notaryProfile!,
        '--wait',
        '--output-format',
        'json',
      ],
      { signal, timeoutMs: NOTARY_TIMEOUT, env: toolEnv },
    );
    fs.writeFileSync(path.join(out, `${name}-notary-submit.json`), result.stdout || result.stderr);
    let response: { id?: string; status?: string } = {};
    try {
      response = z
        .object({ id: z.string().optional(), status: z.string().optional() })
        .parse(JSON.parse(result.stdout));
    } catch {
      /* The raw diagnostic remains in outDir. */
    }
    if (result.code !== 0 || response.status !== 'Accepted') {
      if (response.id) {
        const log = await deps.run(
          'xcrun',
          ['notarytool', 'log', response.id, '--keychain-profile', request.notaryProfile!],
          { signal, timeoutMs: NOTARY_TIMEOUT, env: toolEnv },
        );
        fs.writeFileSync(path.join(out, `${name}-notary-log.json`), log.stdout || log.stderr);
      }
      throw new CloudError(
        `notarization of ${name} failed (${result.code}, ${response.status ?? 'no status'}); see ${out}`,
      );
    }
  };
  try {
    const source = path.join(request.sourceRepo, 'deploy/mac/menubar');
    const swiftArgs = [
      'build',
      '-c',
      'release',
      '--arch',
      'arm64',
      '--package-path',
      source,
      '--scratch-path',
      path.join(work, 'swift'),
      '--cache-path',
      path.join(work, 'cache'),
      '--config-path',
      path.join(work, 'config'),
      '--security-path',
      path.join(work, 'security'),
    ];
    const env = {
      CLANG_MODULE_CACHE_PATH: path.join(work, 'clang-cache'),
      SWIFTPM_MODULECACHE_OVERRIDE: path.join(work, 'module-cache'),
    };
    await checked('swift', swiftArgs, { env });
    const bin = await checked('swift', [...swiftArgs, '--show-bin-path'], { env });
    fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
    fs.cpSync(path.join(bin, 'EngineMenu'), path.join(app, 'Contents/MacOS/EngineMenu'));
    fs.cpSync(path.join(source, 'Resources'), path.join(app, 'Contents/Resources'), { recursive: true });
    const engine = path.join(app, 'Contents/Resources/engine');
    await checked('ditto', [pkg, engine]);
    const values: Record<string, string> = {
      shortVersion: versions.short,
      bundleVersion: versions.build,
      tag: manifest.tag ?? '',
      version: manifest.version,
      repo,
      teamId,
    };
    const template = fs.readFileSync(path.join(request.sourceRepo, 'deploy/mac/app/Info.plist'), 'utf8');
    fs.writeFileSync(
      path.join(app, 'Contents/Info.plist'),
      template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => xml(values[key]!)),
    );
    const files = binaries(engine);
    const node = path.join(engine, 'bin/node');
    if (!files.includes(node)) throw refused('the package has no Mach-O bin/node');
    for (const file of files)
      await sign(
        file,
        file === node ? path.join(request.sourceRepo, 'deploy/mac/app/node.entitlements') : undefined,
      );
    await sign(app);
    await checked('codesign', ['--verify', '--deep', '--strict', app]);
    if (!request.adHoc) {
      const submission = path.join(work, 'notary.zip');
      await checked('ditto', ['-c', '-k', '--keepParent', app, submission]);
      await notarize(submission, 'app');
      await checked('xcrun', ['stapler', 'staple', app]);
    }
    await checked('ditto', ['-c', '-k', '--keepParent', app, zip]);
    const image = path.join(work, 'image');
    fs.mkdirSync(image);
    await checked('ditto', [app, path.join(image, path.basename(app))]);
    fs.symlinkSync('/Applications', path.join(image, 'Applications'));
    await checked('hdiutil', [
      'create',
      '-format',
      'UDZO',
      '-volname',
      'projectman motor',
      '-srcfolder',
      image,
      dmg,
    ]);
    if (!request.adHoc) {
      await sign(dmg);
      await notarize(dmg, 'dmg');
      await checked('xcrun', ['stapler', 'staple', dmg]);
      await checked('spctl', ['-a', '-t', 'exec', '-vv', app]);
    }
    const asset = (file: string) => ({
      name: path.basename(file),
      sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      size: fs.statSync(file).size,
    });
    const release = EngineAppManifest.parse({
      schemaVersion: 1,
      tag: manifest.tag,
      version: manifest.version,
      bundleVersion: versions.build,
      minimumMacOS: '13.0',
      arch: 'arm64',
      teamId,
      zip: asset(zip),
      dmg: asset(dmg),
    });
    fs.writeFileSync(path.join(out, 'projectman-motor.json'), JSON.stringify(release, null, 2) + '\n');
    return { root: out };
  } catch (error) {
    // A failed build must never look publishable; keep only tool diagnostics.
    for (const file of [app, zip, dmg, path.join(out, 'projectman-motor.json')])
      fs.rmSync(file, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
