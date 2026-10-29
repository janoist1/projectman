import fs from 'node:fs';
import { z } from 'zod';
import { refused } from '../cloud/errors';

/**
 * The Node that every engine package bundles (PM-1121): `deploy/mac/app/node.json`. The version must satisfy the
 * root `package.json` `engines.node`; the archive is the one nodejs.org publishes for it, checked by its hash.
 */
const nodePinSchema = z
  .strictObject({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    darwinArm64: z.strictObject({ url: z.url(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  })
  .refine(
    (pin) =>
      pin.darwinArm64.url ===
      `https://nodejs.org/dist/v${pin.version}/node-v${pin.version}-darwin-arm64.tar.gz`,
    { message: 'the url is not the nodejs.org archive of the pinned version' },
  );

export type NodePin = z.infer<typeof nodePinSchema>;

/** The pin of a checkout. A missing, malformed or foreign-url pin refuses the build. */
export function readNodePin(file: string): NodePin {
  try {
    return nodePinSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    throw refused(
      `the Node pin ${file} is missing or invalid${error instanceof z.ZodError ? `: ${error.issues[0]?.message}` : ''}`,
    );
  }
}

/** `major.minor` of a `>=M.m` range, the only shape `engines.node` has. */
function minimumOf(range: string): [number, number] {
  const match = /^>=(\d+)\.(\d+)/.exec(range.trim());
  if (!match) throw refused(`engines.node "${range}" is not a ">=major.minor" range`);
  return [Number(match[1]), Number(match[2])];
}

/** The pinned version satisfies the engine's `engines.node` range. */
export function assertSatisfiesEngines(pin: NodePin, enginesNode: string): void {
  const [major, minor] = pin.version.split('.').map(Number) as [number, number];
  const [minMajor, minMinor] = minimumOf(enginesNode);
  if (major < minMajor || (major === minMajor && minor < minMinor))
    throw refused(`the pinned Node ${pin.version} does not satisfy engines.node ${enginesNode}`);
}
