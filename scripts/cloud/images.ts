import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CloudConfig } from './config';
import type { CloudContext } from './context';
import type { CloudDeps } from './deps';
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
    images: z.array(imageSchema).min(1).max(2),
  })
  .refine((bundle) => new Set(bundle.images.map((image) => image.platform)).size === bundle.images.length);
export type BundleImage = z.output<typeof imageSchema>;
export type Platform = z.output<typeof platformSchema>;

/** The platform of the target machine, by the same rule the deploy uses to pick its image (PM-916). */
export function targetPlatform(config: CloudConfig): Platform {
  return config.aws.compute === 'ec2' && config.aws.ec2?.architecture === 'arm64'
    ? 'linux/arm64'
    : 'linux/amd64';
}
export interface SelectedImage extends BundleImage {
  file: string;
  sourceSha: string;
}

/** No symlink component may redirect a bundle or an output to another directory. */
export function noSymlinks(file: string): void {
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
    const platform = targetPlatform(context.config);
    const image = bundle.images.find((entry) => entry.platform === platform);
    if (!image) throw refused(`image bundle has no ${platform} image`);
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
  // A lost answer: the import may have happened; the caller reconciles instead of streaming again.
  const lost =
    result.code !== 0 && !host.signal.aborted ? host.transportError('receive-image', result) : null;
  if (lost) throw lost;
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

/** What an image build needs of its environment: running a command and piping two. */
export interface ImageBuildTools {
  deps: Pick<CloudDeps, 'run' | 'pipe'>;
}

async function checked(
  context: ImageBuildTools,
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await context.deps.run(command, args, signal ? { signal } : undefined);
  if (result.code !== 0) throw new CloudError(`${command} ${args[0]} failed (status ${result.code})`);
  return result.stdout;
}

/** The exported tracked sources hold no symlink and no runtime data, whatever the commit tracked. */
export function inspectSource(directory: string): void {
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
}

/** Only the tracked files at `ref` enter the context: ignored or untracked runtime files never do. */
async function exportTrackedSource(
  context: ImageBuildTools,
  root: string,
  ref: string,
  source: string,
): Promise<void> {
  const exported = await context.deps.pipe(
    { command: 'git', args: ['-C', root, 'archive', '--format=tar', ref] },
    { command: 'tar', args: ['-x', '-f', '-', '-C', source] },
  );
  if (exported.code !== 0) throw new CloudError('source archive export failed');
  inspectSource(source);
}

async function buildArchive(
  context: ImageBuildTools,
  input: {
    source: string;
    ref: string;
    platform: string;
    file: string;
    metadata: string;
    signal?: AbortSignal;
  },
): Promise<{ imageId: string; archiveSha256: string; archiveBytes: number }> {
  await checked(
    context,
    'docker',
    [
      'buildx',
      'build',
      '--platform',
      input.platform,
      '--build-arg',
      `PROJECTMAN_VERSION=${input.ref}`,
      '--tag',
      `projectman-cloud:${input.ref}`,
      '--output',
      `type=docker,dest=${input.file}`,
      '--metadata-file',
      input.metadata,
      '-f',
      path.join(input.source, 'deploy/cloud/Dockerfile'),
      input.source,
    ],
    input.signal,
  );
  const imageId = imageIdSchema.parse(
    JSON.parse(fs.readFileSync(input.metadata, 'utf8'))['containerimage.config.digest'],
  );
  const digest = archiveDigest(input.file);
  await verifyArchive(context, input.file, imageId, input.platform, input.ref);
  return { imageId, ...digest };
}

/**
 * The administration adapter's image build (PM-764): one platform of the tracked sources of `ref` in the
 * repository at `repo`, built into a throwaway directory under `workDir`. The archive is verified against
 * the Buildx metadata and hashed; it is neither loaded into Docker nor pushed anywhere, and the sources and
 * the archive are removed again — only the digests leave. No working tree is read: `git archive` exports the
 * commit, so an untracked file of the builder's tree cannot reach the build context.
 */
export async function buildPinnedImage(
  context: ImageBuildTools,
  input: { repo: string; ref: string; platform: string; workDir: string; signal?: AbortSignal },
): Promise<{ platform: string; imageId: string; archiveSha256: string; archiveBytes: number }> {
  if (!sourceShaSchema.safeParse(input.ref).success)
    throw badUsage('an image build needs a 40 lowercase hexadecimal commit');
  const platform = platformSchema.parse(input.platform);
  fs.mkdirSync(input.workDir, { recursive: true, mode: 0o700 });
  const out = fs.mkdtempSync(path.join(input.workDir, 'build-'));
  try {
    const source = path.join(out, 'source');
    fs.mkdirSync(source, { mode: 0o700 });
    await exportTrackedSource(context, input.repo, input.ref, source);
    const built = await buildArchive(context, {
      source,
      ref: input.ref,
      platform,
      file: path.join(out, 'image.tar'),
      metadata: path.join(out, 'metadata.json'),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return { platform, ...built };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
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
  context: ImageBuildTools,
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
  requested: readonly Platform[],
): Promise<void> {
  if (!requested.length || new Set(requested).size !== requested.length)
    throw badUsage('image-build needs one or two different platforms');
  // The manifest order is fixed, whatever order the caller asked in.
  const platforms = platformSchema.options.filter((platform) => requested.includes(platform));
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
  for (const platform of platforms)
    if (!new RegExp(`${platform}(?:/v[0-9]+)?(?:[*,\\s]|$)`).test(builder))
      throw refused(`builder does not support ${platform}`);
  context.report.step(
    'ok',
    'image-build',
    `${ref}: ${platforms.join(' and ')} to ${out}${dryRun ? ' (dry-run)' : ''}`,
  );
  if (dryRun) return;
  fs.mkdirSync(out, { mode: 0o700 });
  const source = path.join(out, 'source');
  fs.mkdirSync(source, { mode: 0o700 });
  try {
    await exportTrackedSource(context, root, ref, source);
    const images: BundleImage[] = [];
    for (const platform of platforms) {
      const archive = `${platform.replace('/', '-')}.tar` as BundleImage['archive'];
      const file = path.join(out, archive);
      const built = await buildArchive(context, {
        source,
        ref,
        platform,
        file,
        metadata: path.join(out, `${platform.replace('/', '-')}.metadata.json`),
      });
      const { imageId, ...digest } = built;
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
