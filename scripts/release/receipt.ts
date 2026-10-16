import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CloudError, refused } from '../cloud/errors';
import { imageIdSchema, noSymlinks, platformSchema, sourceShaSchema } from '../cloud/images';

/**
 * The receipt of a hybrid release preparation (PM-750). It states which image bundle and which engine
 * checkout were prepared and verified for one commit; it is neither an approval nor a signature, and it
 * holds no secret or live data. The later coordinator (PM-751) checks every fact again right before it
 * switches anything.
 */

export const RECEIPT_FILE = 'preparation.json';

export const releaseIdSchema = z.string().regex(/^rel_[a-z0-9]{1,40}$/, 'a release id such as rel_…');
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const timestampSchema = z.iso.datetime();
const absolutePathSchema = z
  .string()
  .min(2)
  .refine(
    (value) =>
      path.isAbsolute(value) &&
      path.normalize(value) === value &&
      !value.endsWith(path.sep) &&
      !/[\0\r\n]/.test(value),
    'a normalized absolute path',
  );

const smokeSchema = z.strictObject({
  platform: platformSchema,
  imageId: imageIdSchema,
  checkedAt: timestampSchema,
  nativeModules: z.literal(true),
  helpers: z.literal(true),
  cloudServer: z.literal(true),
});
export type SmokeEvidence = z.output<typeof smokeSchema>;

export const preparedHybridReleaseSchema = z
  .strictObject({
    version: z.literal(1),
    releaseId: releaseIdSchema,
    commit: sourceShaSchema,
    preparedAt: timestampSchema,
    manifestPath: absolutePathSchema,
    manifestSha256: sha256Schema,
    engine: z.strictObject({ root: absolutePathSchema, lockfileSha256: sha256Schema }),
    smoke: z.array(smokeSchema).length(2),
  })
  .refine((receipt) => new Set(receipt.smoke.map((entry) => entry.platform)).size === 2, {
    message: 'the smoke evidence needs two different platforms',
    path: ['smoke'],
  });
export type PreparedHybridRelease = z.output<typeof preparedHybridReleaseSchema>;

/** The marker beside a finished engine candidate: the only thing that lets a later run reuse the directory. */
export const candidateMarkerSchema = z.strictObject({
  version: z.literal(1),
  releaseId: releaseIdSchema,
  commit: sourceShaSchema,
  root: absolutePathSchema,
  lockfileSha256: sha256Schema,
  installedTreeSha256: sha256Schema,
  serverBundleSha256: sha256Schema,
  preparedAt: timestampSchema,
});
export type CandidateMarker = z.output<typeof candidateMarkerSchema>;

/** SHA-256 of a regular file read through its descriptor; a symlink, a non-file or a change while reading is refused. */
export function hashRegularFile(file: string): string {
  noSymlinks(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw refused('a hashed input must be a regular file');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const count = fs.readSync(fd, buffer);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw refused('a hashed input changed while it was read');
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

/** A small regular file read once: the text and its SHA-256 come from the same bytes, so they cannot differ. */
export function readRegularFileWithHash(file: string): { text: string; sha256: string } {
  noSymlinks(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw refused('a hashed input must be a regular file');
    const bytes = fs.readFileSync(fd);
    return { text: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    fs.closeSync(fd);
  }
}

/** Writes a new 0600 file without ever replacing an existing one (hard link of a complete temporary file). */
function writeNewFile(file: string, content: string): void {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(6).toString('hex')}.new`,
  );
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  try {
    fs.linkSync(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw refused(`${path.basename(file)} already exists`);
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** The receipt exists only once everything was verified; the directory it lands in is 0700. */
export function writeReceipt(outputDir: string, value: PreparedHybridRelease): string {
  const receipt = preparedHybridReleaseSchema.parse(value);
  const stat = fs.lstatSync(outputDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw refused('the receipt directory must be a private (0700) directory');
  const file = path.join(outputDir, RECEIPT_FILE);
  writeNewFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  return file;
}

export function readReceipt(file: string): PreparedHybridRelease {
  try {
    hashRegularFile(file);
    return preparedHybridReleaseSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw refused('the preparation receipt is missing or invalid');
  }
}

export function candidateMarkerFile(root: string): string {
  return `${root}.candidate.json`;
}

export function writeCandidateMarker(value: CandidateMarker): void {
  writeNewFile(
    candidateMarkerFile(value.root),
    `${JSON.stringify(candidateMarkerSchema.parse(value), null, 2)}\n`,
  );
}

export function readCandidateMarker(root: string): CandidateMarker | undefined {
  const file = candidateMarkerFile(root);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return undefined;
  try {
    hashRegularFile(file);
    return candidateMarkerSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    throw refused('the engine candidate marker is invalid');
  }
}
