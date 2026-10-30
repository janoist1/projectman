import { z } from 'zod';

/**
 * The manifest of a self-contained engine package (PM-1104, PM-1121): `engine-package.json` in the package root.
 * `npm run engine-app -- package` writes it, the packaged engine's CLI and version reader (`engine-link`) read it.
 * A package has no git checkout, so the version and the release tag come from here.
 */
export const EnginePackageManifest = z.strictObject({
  schemaVersion: z.literal(1),
  /** The commit the package was built from. */
  version: z.string().regex(/^[0-9a-f]{40}$/),
  /** `vYYYY.M.D[.N]` when the commit carries a release tag. */
  tag: z.string().nullable(),
  /** The bundled Node, e.g. `22.12.0`. */
  node: z.string(),
  arch: z.literal('arm64'),
  /** ISO timestamp. */
  builtAt: z.string(),
});
export type EnginePackageManifest = z.infer<typeof EnginePackageManifest>;
