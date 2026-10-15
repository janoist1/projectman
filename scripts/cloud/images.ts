import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CloudContext } from './context';
import { badUsage, CloudError, refused } from './errors';
import type { HostSession } from './host';

export const sourceShaSchema = z
  .string()
  .length(40)
  .regex(/^[0-9a-f]{40}$/);
export const imageIdSchema = z
  .string()
  .length(71)
  .regex(/^sha256:[0-9a-f]{64}$/);
export const platformSchema = z.enum(['linux/amd64', 'linux/arm64']);
const imageSchema = z
  .strictObject({
    platform: platformSchema,
    archive: z.enum(['linux-amd64.tar', 'linux-arm64.tar']),
    archiveSha256: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/),
    archiveBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    imageId: imageIdSchema,
  })
  .refine((image) => image.archive === `${image.platform.replace('/', '-')}.tar`);
export const bundleSchema = z
  .strictObject({
    version: z.literal(1),
    sourceSha: sourceShaSchema,
    images: z.array(imageSchema).length(2),
  })
  .refine((bundle) => new Set(bundle.images.map((image) => image.platform)).size === 2);
export type BundleImage = z.output<typeof imageSchema>;
export interface SelectedImage extends BundleImage {
  file: string;
  sourceSha: string;
}

/** No symlink component may redirect a bundle or an output to another directory. */
function noSymlinks(file: string): void {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw refused('image paths must not contain symlinks');
    if (path.dirname(current) === current) break;
  }
}

export function archiveDigest(file: string): { archiveSha256: string; archiveBytes: number } {
  noSymlinks(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw refused('image archive must be a non-empty regular file of safe size');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    const fingerprint = (stat: fs.BigIntStats) =>
      [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    if (
      fingerprint(before) !== fingerprint(after) ||
      fingerprint(before) !== fingerprint(named) ||
      BigInt(bytes) !== before.size
    )
      throw refused('image archive changed during hashing');
    return { archiveSha256: hash.digest('hex'), archiveBytes: bytes };
  } finally {
    fs.closeSync(fd);
  }
}

export function selectedImage(context: CloudContext, sha?: string): SelectedImage | undefined {
  const directory = context.config.deployment?.imageBundle;
  if (!directory) {
    if (context.config.aws.ec2?.architecture === 'arm64') throw refused('arm64 requires an image bundle');
    return undefined;
  }
  try {
    noSymlinks(directory);
    const manifestFile = path.join(directory, 'manifest.json');
    noSymlinks(manifestFile);
    if (!fs.lstatSync(manifestFile).isFile()) throw refused('manifest must be a regular file');
    const bundle = bundleSchema.parse(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
    if (sha !== undefined && bundle.sourceSha !== sha)
      throw refused('bundle source SHA differs from the deployment target');
    const platform =
      context.config.aws.compute === 'ec2' && context.config.aws.ec2?.architecture === 'arm64'
        ? 'linux/arm64'
        : 'linux/amd64';
    const image = bundle.images.find((entry) => entry.platform === platform)!;
    const file = path.join(directory, image.archive);
    const digest = archiveDigest(file);
    if (digest.archiveBytes !== image.archiveBytes || digest.archiveSha256 !== image.archiveSha256)
      throw refused('image archive hash or size differs from the manifest');
    context.report.step(
      'ok',
      'image',
      `source=${bundle.sourceSha} platform=${platform} archiveSha256=${image.archiveSha256} imageId=${image.imageId}`,
    );
    return { ...image, sourceSha: bundle.sourceSha, file };
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw refused('image bundle is missing or invalid');
  }
}

export async function receiveImage(
  context: CloudContext,
  host: HostSession,
  image: SelectedImage,
): Promise<void> {
  // Recheck after any seed upload and immediately before streaming; the host independently hashes stdin.
  const digest = archiveDigest(image.file);
  if (digest.archiveSha256 !== image.archiveSha256 || digest.archiveBytes !== image.archiveBytes)
    throw new CloudError('image archive changed before transfer');
  const command = await host.command('receive-image', [
    image.sourceSha,
    image.platform,
    String(image.archiveBytes),
    image.archiveSha256,
    image.imageId,
  ]);
  const result = await context.deps.pipe({ command: 'cat', args: [image.file] }, command);
  if (result.code === 3) throw refused('the host refused the image import');
  if (result.code !== 0 || host.signal.aborted) throw new CloudError('image stream or import failed');
  const schema = z.strictObject({
    imageId: imageIdSchema,
    platform: platformSchema,
    revision: sourceShaSchema,
  });
  try {
    const actual = schema.parse(JSON.parse(result.stdout));
    if (
      actual.imageId !== image.imageId ||
      actual.platform !== image.platform ||
      actual.revision !== image.sourceSha
    )
      throw new Error('mismatch');
  } catch {
    throw new CloudError('the host answered image verification with invalid metadata');
  }
}

async function checked(context: CloudContext, command: string, args: string[]): Promise<string> {
  const result = await context.deps.run(command, args);
  if (result.code !== 0) throw new CloudError(`${command} ${args[0]} failed (status ${result.code})`);
  return result.stdout;
}

/** Validate loaded image content, never trust a tag or Buildx's platform declaration alone. */
export function verifyImage(value: unknown, imageId: string, platform: string, sha: string): void {
  const schema = z
    .array(
      z.looseObject({
        Id: imageIdSchema,
        Os: z.literal('linux'),
        Architecture: z.string(),
        Config: z.looseObject({ Labels: z.record(z.string(), z.string()), Env: z.array(z.string()) }),
      }),
    )
    .length(1);
  const parsed = schema.safeParse(value);
  const image = parsed.success ? parsed.data[0] : undefined;
  if (
    !image ||
    image.Id !== imageId ||
    `linux/${image.Architecture}` !== platform ||
    image.Config.Labels['org.opencontainers.image.revision'] !== sha ||
    image.Config.Env.filter((entry) => entry.startsWith('PROJECTMAN_VERSION=')).join() !==
      `PROJECTMAN_VERSION=${sha}`
  )
    throw new CloudError('built image ID, platform, revision or version does not match');
}

async function verifyArchive(
  context: CloudContext,
  file: string,
  imageId: string,
  platform: string,
  sha: string,
): Promise<void> {
  const entries = z
    .array(
      z.looseObject({
        Config: z.string().regex(/^(?:[0-9a-f]{64}\.json|blobs\/sha256\/[0-9a-f]{64})$/),
        RepoTags: z.array(z.string()).length(1),
      }),
    )
    .length(1)
    .parse(JSON.parse(await checked(context, 'tar', ['-xOf', file, 'manifest.json'])));
  const entry = entries[0]!;
  if (entry.RepoTags[0] !== `projectman-cloud:${sha}`)
    throw new CloudError('archive contains unexpected tags');
  const configText = await checked(context, 'tar', ['-xOf', file, entry.Config]);
  if (`sha256:${createHash('sha256').update(configText).digest('hex')}` !== imageId)
    throw new CloudError('archive config digest differs from Buildx metadata');
  const config = JSON.parse(configText);
  verifyImage(
    [{ Id: imageId, Os: config.os, Architecture: config.architecture, Config: config.config }],
    imageId,
    platform,
    sha,
  );
}

export async function runImageBuild(
  context: CloudContext,
  ref: string,
  output: string,
  dryRun: boolean,
): Promise<void> {
  if (!sourceShaSchema.safeParse(ref).success)
    throw badUsage('image-build --ref needs 40 lowercase hexadecimal characters');
  if (/[\0\r\n,]/.test(output)) throw badUsage('image-build --out contains an invalid character');
  const out = path.resolve(output);
  let root: string;
  try {
    root = fs.realpathSync(context.deps.repoRoot);
    noSymlinks(out);
    if (out === root || out.startsWith(`${root}${path.sep}`) || fs.lstatSync(out, { throwIfNoEntry: false }))
      throw refused('image-build output must be a new directory outside the repository');
    if (!fs.statSync(path.dirname(out)).isDirectory()) throw refused('image-build output parent must exist');
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw refused('builder checkout or output parent is missing or inaccessible');
  }
  const git = (args: string[]) => checked(context, 'git', ['-C', root, ...args]);
  if ((await git(['rev-parse', 'HEAD'])).trim() !== ref) throw refused('builder HEAD differs from --ref');
  if ((await git(['status', '--porcelain', '--untracked-files=all'])).trim())
    throw refused('builder checkout is dirty');
  const builder = await checked(context, 'docker', ['buildx', 'inspect']);
  if (!/^Driver:\s+docker-container\s*$/m.test(builder))
    throw refused('a pre-existing docker-container Buildx builder is required');
  for (const arch of ['amd64', 'arm64'])
    if (!new RegExp(`linux/${arch}(?:/v[0-9]+)?(?:[*,\\s]|$)`).test(builder))
      throw refused(`builder does not support linux/${arch}`);
  context.report.step(
    'ok',
    'image-build',
    `${ref}: linux/amd64 and linux/arm64 to ${out}${dryRun ? ' (dry-run)' : ''}`,
  );
  if (dryRun) return;
  fs.mkdirSync(out, { mode: 0o700 });
  const source = path.join(out, 'source');
  fs.mkdirSync(source, { mode: 0o700 });
  try {
    // Only tracked files at the checked SHA enter the context: ignored runtime files never enter it.
    const exported = await context.deps.pipe(
      { command: 'git', args: ['-C', root, 'archive', '--format=tar', ref] },
      { command: 'tar', args: ['-x', '-f', '-', '-C', source] },
    );
    if (exported.code !== 0) throw new CloudError('source archive export failed');
    const inspectSource = (directory: string) => {
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name);
        const stat = fs.lstatSync(file);
        if (
          stat.isSymbolicLink() ||
          /^(cloud\.env|\.env(?:\..*)?|\.aws|\.ssh|\.projectman|secrets|db\.sqlite(?:-.*)?)$/.test(name)
        )
          throw refused('source context contains a symlink or runtime data');
        if (stat.isDirectory()) inspectSource(file);
      }
    };
    inspectSource(source);
    const images: BundleImage[] = [];
    for (const platform of platformSchema.options) {
      const archive = `${platform.replace('/', '-')}.tar` as BundleImage['archive'];
      const file = path.join(out, archive);
      const metadata = path.join(out, `${platform.replace('/', '-')}.metadata.json`);
      await checked(context, 'docker', [
        'buildx',
        'build',
        '--platform',
        platform,
        '--build-arg',
        `PROJECTMAN_VERSION=${ref}`,
        '--tag',
        `projectman-cloud:${ref}`,
        '--output',
        `type=docker,dest=${file}`,
        '--metadata-file',
        metadata,
        '-f',
        path.join(source, 'deploy/cloud/Dockerfile'),
        source,
      ]);
      const imageId = imageIdSchema.parse(
        JSON.parse(fs.readFileSync(metadata, 'utf8'))['containerimage.config.digest'],
      );
      const digest = archiveDigest(file);
      await verifyArchive(context, file, imageId, platform, ref);
      await checked(context, 'docker', ['load', '--input', file]);
      verifyImage(
        JSON.parse(await checked(context, 'docker', ['image', 'inspect', imageId])),
        imageId,
        platform,
        ref,
      );
      images.push({ platform, archive, ...digest, imageId });
      context.report.step(
        'ok',
        'image',
        `source=${ref} platform=${platform} archiveSha256=${digest.archiveSha256} imageId=${imageId}`,
      );
    }
    const manifest = bundleSchema.parse({ version: 1, sourceSha: ref, images });
    const temporary = path.join(out, '.manifest.json.new');
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path.join(out, 'manifest.json'));
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
}
