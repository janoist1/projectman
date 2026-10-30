import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readEnginePackage } from '../../apps/server/src/engine-link/engine-package';
import {
  computeJobArtifact,
  locateComputeJobRun,
  regularFile,
  verifyAttestation,
  type ComputeJobContext,
} from '../cloud/compute-job-run';
import { CloudError, refused } from '../cloud/errors';
import { checked, newOutputDirectory } from '../cloud/images';
import { ENGINE_APP_JOB } from './job';
import { EngineAppManifest } from './manifest';

/**
 * Fetches the engine app that the general GitHub workflow built (PM-1156), the same way `image-fetch` fetches the
 * cloud image: finds or follows the `engine-app` run (never starts one), checks where it ran, verifies the
 * attestation of all three files, the manifest against the commit and the files, then unpacks the app and checks
 * its signature and the engine package inside it. Needs `gh` (read access to the Actions of the repository), `ditto`,
 * `codesign` and, with `--open`, `open`. Any failure removes the output directory.
 */

const MANIFEST_OUTPUT = ENGINE_APP_JOB.outputs[0]!;
const ZIP_OUTPUT = ENGINE_APP_JOB.outputs[1]!;
const DMG_OUTPUT = ENGINE_APP_JOB.outputs[2]!;
const APP_NAME = 'projectman motor.app';
const ENGINE_DIRECTORY = 'Contents/Resources/engine';

export interface EngineAppFetchRequest {
  commit: string;
  out: string;
  run?: number;
  dryRun: boolean;
  open: boolean;
}

function fileDigest(file: string): { sha256: string; size: number } {
  const content = fs.readFileSync(file);
  return { sha256: createHash('sha256').update(content).digest('hex'), size: content.length };
}

/** The manifest must describe this commit and exactly the downloaded zip and dmg. */
function checkedManifest(incoming: string, commit: string): EngineAppManifest {
  let manifest: EngineAppManifest;
  try {
    manifest = EngineAppManifest.parse(
      JSON.parse(fs.readFileSync(path.join(incoming, MANIFEST_OUTPUT), 'utf8')),
    );
  } catch {
    throw refused('the engine app manifest is invalid');
  }
  if (manifest.version !== commit) throw refused('the engine app was built from another commit');
  for (const [asset, output] of [
    [manifest.zip, ZIP_OUTPUT],
    [manifest.dmg, DMG_OUTPUT],
  ] as const) {
    const actual = fileDigest(path.join(incoming, output));
    if (actual.sha256 !== asset.sha256 || actual.size !== asset.size)
      throw refused(`${asset.name} hash or size differs from the manifest`);
  }
  return manifest;
}

/** Unpacks the zip into `out`; only the app may come out of it, and its signature and engine package must hold. */
async function unpackedApp(
  context: ComputeJobContext,
  input: { commit: string; out: string; zip: string },
): Promise<string> {
  const { deps } = context;
  const { commit, out } = input;
  await checked(context, 'ditto', ['-x', '-k', input.zip, out]);
  const app = path.join(out, APP_NAME);
  const names = fs.readdirSync(out).filter((name) => name !== '.incoming');
  if (names.length !== 1 || names[0] !== APP_NAME || !fs.lstatSync(app).isDirectory())
    throw refused(`the engine app zip does not hold exactly ${APP_NAME}`);
  const verified = await deps.run('codesign', ['--verify', '--deep', '--strict', app]);
  if (verified.code !== 0) throw refused('the code signature of the engine app is not valid');
  if (readEnginePackage(path.join(app, ENGINE_DIRECTORY))?.version !== commit)
    throw refused('the engine package inside the app is not of this commit');
  return app;
}

/**
 * Returns the path of the unpacked app (the last line the command prints); with `dryRun` it stops at the run
 * and returns its address. With `open` it opens the app, which installs itself by its own release switch.
 */
export async function fetchEngineApp(
  context: ComputeJobContext,
  request: EngineAppFetchRequest,
): Promise<string> {
  const { deps, report } = context;
  const { commit } = request;
  const { root, out } = newOutputDirectory(deps, 'engine-app fetch', request.out);
  const run = await locateComputeJobRun(context, {
    root,
    ref: commit,
    job: ENGINE_APP_JOB,
    ...(request.run === undefined ? {} : { run: request.run }),
  });
  if (request.dryRun) {
    report.step('ok', 'engine-app fetch', `${commit}: ${run.url} to ${out} (dry-run)`);
    return run.url;
  }
  const artifact = await computeJobArtifact(context, run);
  fs.mkdirSync(out, { mode: 0o700 });
  let app: string;
  try {
    const incoming = path.join(out, '.incoming');
    await checked(context, 'gh', [
      'run',
      'download',
      String(run.id),
      '--repo',
      run.repo,
      '--name',
      artifact.name,
      '--dir',
      incoming,
    ]);
    for (const output of ENGINE_APP_JOB.outputs)
      await verifyAttestation(
        context,
        { repo: run.repo, branch: run.branch, run: run.id },
        regularFile(path.join(incoming, output)),
      );
    const manifest = checkedManifest(incoming, commit);
    app = await unpackedApp(context, { commit, out, zip: path.join(incoming, ZIP_OUTPUT) });
    for (const output of ENGINE_APP_JOB.outputs)
      fs.renameSync(path.join(incoming, output), path.join(out, path.basename(output)));
    fs.rmSync(incoming, { recursive: true, force: true });
    report.step(
      'ok',
      'engine-app',
      `source=${commit} teamId=${manifest.teamId || '(ad-hoc, updater off)'} zipSha256=${manifest.zip.sha256} run=${run.url}`,
    );
  } catch (error) {
    fs.rmSync(out, { recursive: true, force: true });
    throw error;
  }
  if (request.open) {
    const opened = await deps.run('open', [app]);
    if (opened.code !== 0) throw new CloudError(`open failed (status ${opened.code}); the app is at ${app}`);
  }
  return app;
}
