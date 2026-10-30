import fs from 'node:fs';
import path from 'node:path';
import { EnginePackageManifest } from '../contracts';

/** The manifest's file name in the root of an engine package (PM-1104). */
export const ENGINE_PACKAGE_FILE = 'engine-package.json';

/**
 * The manifest of the engine package installed in `installDir`; null when there is none (a checkout) or it is
 * unreadable or invalid. Never throws: the callers fall back to git.
 */
export function readEnginePackage(installDir: string): EnginePackageManifest | null {
  try {
    const parsed = EnginePackageManifest.safeParse(
      JSON.parse(fs.readFileSync(path.join(installDir, ENGINE_PACKAGE_FILE), 'utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
