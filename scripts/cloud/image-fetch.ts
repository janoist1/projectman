import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  COMPUTE_JOB_WORKFLOW,
  ComputeJobRunId,
  parseComputeJobRunTitle,
  type GithubJobRunner,
} from '@projectman/shared';
import type { CloudDeps } from './deps';
import { badUsage, CloudError, refused } from './errors';
import { githubRepoOf } from './github';
import {
  archiveDigest,
  bundleSchema,
  checked,
  imageRef,
  newOutputDirectory,
  noSymlinks,
  verifyArchive,
} from './images';
import type { Report } from './report';

/** The cloud image as a compute job (PM-1145); `docs/AWS.md` "Prebuilt ARM images" lists the same values. */
export const CLOUD_IMAGE_JOB = {
  job: 'cloud-image',
  runsOn: 'ubuntu-24.04-arm' satisfies GithubJobRunner,
  node: '22',
  timeoutMinutes: '60',
  outputs: ['bundle/manifest.json', 'bundle/linux-arm64.tar'],
  command:
    'npm ci && docker buildx create --name projectman --driver docker-container --bootstrap --use && ' +
    'npm run cloud -- image-build --ref "$PROJECTMAN_JOB_COMMIT" --out "$PROJECTMAN_JOB_OUT/bundle"',
} as const;

const POLL_MS = 15_000;
const MAX_WAIT_MS = 60 * 60 * 1000;
const WORKFLOW_PATH = `.github/workflows/${COMPUTE_JOB_WORKFLOW}`;
const MANIFEST_OUTPUT = CLOUD_IMAGE_JOB.outputs[0];
const ARCHIVE_OUTPUT = CLOUD_IMAGE_JOB.outputs[1];

/** What the fetch needs of its environment: processes, the clock and the output report. */
export interface ImageFetchContext {
  deps: Pick<CloudDeps, 'run' | 'pipe' | 'now' | 'sleep' | 'repoRoot'>;
  report: Report;
}

const runSchema = z.looseObject({
  id: z.number().int().positive(),
  path: z.string(),
  event: z.string(),
  head_branch: z.string().nullable(),
  status: z.string(),
  conclusion: z.string().nullable(),
  display_title: z.string(),
});
type Run = z.output<typeof runSchema>;

const runListSchema = z.array(
  z.looseObject({ databaseId: z.number().int().positive(), displayTitle: z.string(), createdAt: z.string() }),
);

const attestationsSchema = z.array(
  z.looseObject({
    verificationResult: z.looseObject({
      signature: z.looseObject({
        certificate: z.looseObject({ runInvocationURI: z.string().optional() }).optional(),
      }),
      statement: z
        .looseObject({
          predicate: z
            .looseObject({
              runDetails: z
                .looseObject({ metadata: z.looseObject({ invocationId: z.string().optional() }).optional() })
                .optional(),
            })
            .optional(),
        })
        .optional(),
    }),
  }),
);

/** The `gh workflow run` line that starts the cloud image job on the default branch, for the owner to run. */
export function cloudImageLaunchCommand(repo: string, branch: string, ref: string, now: Date): string {
  const runId = `manual-${ref.slice(0, 8)}-${now.toISOString().replace(/\D/g, '').slice(0, 14)}`;
  const fields = [
    ['job', CLOUD_IMAGE_JOB.job],
    ['run_id', runId],
    ['commit', ref],
    ['runs_on', CLOUD_IMAGE_JOB.runsOn],
    ['node', CLOUD_IMAGE_JOB.node],
    ['timeout_minutes', CLOUD_IMAGE_JOB.timeoutMinutes],
    ['outputs', `'${CLOUD_IMAGE_JOB.outputs.join(' ')}'`],
    ['command', `'${CLOUD_IMAGE_JOB.command}'`],
  ];
  const inputs = fields.map(([name, value]) => `-f ${name}=${value}`).join(' ');
  return `gh workflow run ${COMPUTE_JOB_WORKFLOW} --repo ${repo} --ref ${branch} ${inputs}`;
}

function runUrl(repo: string, id: number): string {
  return `https://github.com/${repo}/actions/runs/${id}`;
}

function parseJson<T>(text: string, schema: z.ZodType<T>, what: string): T {
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw new CloudError(`${what} could not be read`);
  }
}

async function readRun(context: ImageFetchContext, repo: string, id: number): Promise<Run> {
  const text = await checked(context, 'gh', ['api', `repos/${repo}/actions/runs/${id}`]);
  return parseJson(text, runSchema, `run ${id}`);
}

/** The newest run of the job at this commit, or null; GitHub's own list is the only source. */
async function findRun(
  context: ImageFetchContext,
  repo: string,
  branch: string,
  ref: string,
): Promise<number | null> {
  const text = await checked(context, 'gh', [
    'run',
    'list',
    '--repo',
    repo,
    '--workflow',
    COMPUTE_JOB_WORKFLOW,
    '--event',
    'workflow_dispatch',
    '--branch',
    branch,
    '--json',
    'databaseId,displayTitle,status,conclusion,createdAt',
    '--limit',
    '50',
  ]);
  const runs = parseJson(text, runListSchema, 'the run list')
    .filter((run) => {
      const title = parseComputeJobRunTitle(run.displayTitle);
      return title?.job === CLOUD_IMAGE_JOB.job && title.commit === ref;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return runs[0]?.databaseId ?? null;
}

/** Follows a run that is still going: every 15 seconds, for at most 60 minutes. */
async function finishedRun(context: ImageFetchContext, repo: string, id: number): Promise<Run> {
  const { deps, report } = context;
  const deadline = deps.now().getTime() + MAX_WAIT_MS;
  for (;;) {
    const run = await readRun(context, repo, id);
    if (run.status === 'completed') return run;
    if (deps.now().getTime() >= deadline)
      throw new CloudError(`run ${runUrl(repo, id)} did not finish within 60 minutes`);
    report.line(`waiting for ${runUrl(repo, id)} (${run.status})`);
    await deps.sleep(POLL_MS);
  }
}

/** The run must be this workflow's, dispatched on the default branch, successful and about this commit. */
function checkOrigin(run: Run, input: { repo: string; branch: string; ref: string }): string {
  const url = runUrl(input.repo, run.id);
  const title = parseComputeJobRunTitle(run.display_title);
  if (run.path !== WORKFLOW_PATH) throw refused(`run ${url} is not a ${COMPUTE_JOB_WORKFLOW} run`);
  if (run.event !== 'workflow_dispatch') throw refused(`run ${url} was not started by hand`);
  if (run.head_branch !== input.branch)
    throw refused(`run ${url} did not run on the default branch ${input.branch}`);
  if (run.conclusion !== 'success')
    throw refused(`run ${url} did not succeed (${run.conclusion ?? 'no result'})`);
  if (title?.job !== CLOUD_IMAGE_JOB.job || title.commit !== input.ref)
    throw refused(`run ${url} is not the ${CLOUD_IMAGE_JOB.job} job of ${input.ref}`);
  return title.runId;
}

/** Both the exact workflow identity and this very run must have signed the file. */
export async function verifyAttestation(
  context: ImageFetchContext,
  input: { repo: string; branch: string; run: number },
  file: string,
): Promise<void> {
  const identity = `https://github.com/${input.repo}/.github/workflows/${COMPUTE_JOB_WORKFLOW}@refs/heads/${input.branch}`;
  const result = await context.deps.run('gh', [
    'attestation',
    'verify',
    file,
    '--repo',
    input.repo,
    '--cert-identity',
    identity,
    '--deny-self-hosted-runners',
    '--format',
    'json',
  ]);
  const name = path.basename(file);
  if (result.code !== 0) throw refused(`the attestation of ${name} was not verified`);
  const prefix = `${runUrl(input.repo, input.run)}/`;
  const fromThisRun = (uri: string | undefined) =>
    uri !== undefined && uri.startsWith(prefix) && /^attempts\/[0-9]+$/.test(uri.slice(prefix.length));
  let attested: z.output<typeof attestationsSchema>;
  try {
    attested = attestationsSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw refused(`the attestation of ${name} could not be read`);
  }
  const matches = attested.some(
    ({ verificationResult }) =>
      fromThisRun(verificationResult.signature.certificate?.runInvocationURI) ||
      fromThisRun(verificationResult.statement?.predicate?.runDetails?.metadata?.invocationId),
  );
  if (!matches) throw refused(`the attestation of ${name} is not from run ${input.run}`);
}

function regularFile(file: string): string {
  noSymlinks(file);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile())
    throw refused(`${path.basename(file)} is missing from the downloaded run`);
  return file;
}

/** Checks the downloaded, attested bundle and moves it into `out`, the manifest last. */
async function installBundle(
  context: ImageFetchContext,
  input: { ref: string; out: string; incoming: string },
): Promise<{ imageId: string; platform: string; archiveSha256: string }> {
  const { ref, out, incoming } = input;
  const manifestFile = regularFile(path.join(incoming, MANIFEST_OUTPUT));
  const archiveFile = regularFile(path.join(incoming, ARCHIVE_OUTPUT));
  const manifestText = fs.readFileSync(manifestFile, 'utf8');
  let bundle: z.output<typeof bundleSchema>;
  try {
    bundle = bundleSchema.parse(JSON.parse(manifestText));
  } catch {
    throw refused('the bundle manifest is invalid');
  }
  if (bundle.sourceSha !== ref) throw refused('the bundle was built from another commit');
  const image = bundle.images[0]!;
  const digest = archiveDigest(archiveFile);
  if (digest.archiveBytes !== image.archiveBytes || digest.archiveSha256 !== image.archiveSha256)
    throw refused('image archive hash or size differs from the manifest');
  await verifyArchive(context, archiveFile, image.imageId, image.platform, ref);
  fs.renameSync(archiveFile, path.join(out, image.archive));
  fs.rmSync(incoming, { recursive: true, force: true });
  const temporary = path.join(out, '.manifest.json.new');
  fs.writeFileSync(temporary, manifestText, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, path.join(out, 'manifest.json'));
  return image;
}

/** A checked, successful run of the cloud image job at one commit (what `image-fetch` and `deploy` both start from). */
export interface CloudImageRun {
  repo: string;
  branch: string;
  /** The GitHub run number. */
  id: number;
  /** The `run_id` input of the workflow, which names the artifact. */
  runId: string;
  url: string;
}

/** The value of a `--run` option: a GitHub Actions run number. */
export function runNumber(command: string, value: string): number {
  if (!/^[0-9]{1,18}$/.test(value))
    throw badUsage(`${command} --run needs the number of a GitHub Actions run`);
  return Number(value);
}

/**
 * Finds (or takes the given) run of the cloud image job at `ref`, follows it until it ends and checks where it
 * ran (workflow, event, default branch, result, title). Never starts a run: it names the command that would.
 */
export async function locateCloudImageRun(
  context: ImageFetchContext,
  input: { root: string; ref: string; run?: number },
): Promise<CloudImageRun> {
  const { root, ref } = input;
  const repo = githubRepoOf(
    (await checked(context, 'git', ['-C', root, 'remote', 'get-url', 'origin'])).trim(),
  );
  const repository = parseJson(
    await checked(context, 'gh', ['api', `repos/${repo}`]),
    z.looseObject({ default_branch: z.string().min(1) }),
    `repository ${repo}`,
  );
  const branch = repository.default_branch;
  const id = input.run ?? (await findRun(context, repo, branch, ref));
  if (id === null)
    throw refused(
      `no ${COMPUTE_JOB_WORKFLOW} run of ${CLOUD_IMAGE_JOB.job} for ${ref}; start one with:\n` +
        cloudImageLaunchCommand(repo, branch, ref, context.deps.now()),
    );
  const run = await finishedRun(context, repo, id);
  const runId = ComputeJobRunId.parse(checkOrigin(run, { repo, branch, ref }));
  return { repo, branch, id, runId, url: runUrl(repo, id) };
}

const artifactListSchema = z.looseObject({
  artifacts: z.array(
    z.looseObject({
      id: z.number().int().positive(),
      name: z.string(),
      size_in_bytes: z.number().int().positive(),
      expired: z.boolean(),
    }),
  ),
});

/** The one live artifact `projectman-job-<run_id>` of the run; an expired one means the run must be repeated. */
export async function cloudImageArtifact(
  context: ImageFetchContext,
  run: CloudImageRun,
): Promise<{ id: number; name: string; bytes: number }> {
  const name = `projectman-job-${run.runId}`;
  const list = parseJson(
    await checked(context, 'gh', ['api', `repos/${run.repo}/actions/runs/${run.id}/artifacts?per_page=100`]),
    artifactListSchema,
    `the artifacts of run ${run.id}`,
  );
  const named = list.artifacts.filter((artifact) => artifact.name === name);
  const live = named.filter((artifact) => !artifact.expired);
  if (live.length === 1) return { id: live[0]!.id, name, bytes: live[0]!.size_in_bytes };
  if (live.length > 1) throw refused(`run ${run.url} has more than one artifact ${name}`);
  throw refused(
    named.length > 0
      ? `the artifact ${name} of run ${run.url} has expired (7 days); start the run again`
      : `run ${run.url} has no artifact ${name}`,
  );
}

/**
 * The short-lived (about one minute) pre-signed link of an artifact's zip. It is a credential: it goes to the
 * machine on a standard input and nowhere else, so it is registered with the report and never in a message. The
 * request must not follow the redirect (`gh api` would, and the 460 MB would come to this computer).
 */
export async function artifactDownloadUrl(
  context: Pick<ImageFetchContext, 'report'> & { deps: Pick<CloudDeps, 'run' | 'pipe' | 'fetch'> },
  repo: string,
  artifactId: number,
): Promise<string> {
  const token = (await checked(context, 'gh', ['auth', 'token'])).trim();
  if (!token) throw refused('gh is not logged in');
  context.report.protect(token);
  let response: Response;
  try {
    response = await context.deps.fetch(
      `https://api.github.com/repos/${repo}/actions/artifacts/${artifactId}/zip`,
      {
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new CloudError(`the download link of artifact ${artifactId} could not be requested`);
  }
  const location = response.headers.get('location');
  if (response.status !== 302 || location === null || !location.startsWith('https://'))
    throw new CloudError(
      `GitHub gave no download link for artifact ${artifactId} (status ${response.status})`,
    );
  context.report.protect(location);
  return location;
}

/**
 * Fetches the cloud image bundle that the general GitHub workflow built (PM-1145): finds or follows the run
 * (never starts one), checks where it ran, verifies the attestation of both files and the bundle, and writes
 * a bundle `deploy` accepts. Needs no cloud configuration and no Docker.
 */
export async function runImageFetch(
  context: ImageFetchContext,
  input: { ref: string; output: string; run?: string; dryRun: boolean },
): Promise<void> {
  const { deps, report } = context;
  const { ref } = input;
  imageRef('image-fetch', ref);
  const requested = input.run === undefined ? undefined : runNumber('image-fetch', input.run);
  const { root, out } = newOutputDirectory(deps, 'image-fetch', input.output);
  const { repo, branch, id, runId, url } = await locateCloudImageRun(context, {
    root,
    ref,
    ...(requested === undefined ? {} : { run: requested }),
  });
  if (input.dryRun) {
    report.step('ok', 'image-fetch', `${ref}: ${url} to ${out} (dry-run)`);
    return;
  }
  fs.mkdirSync(out, { mode: 0o700 });
  try {
    const incoming = path.join(out, '.incoming');
    await checked(context, 'gh', [
      'run',
      'download',
      String(id),
      '--repo',
      repo,
      '--name',
      `projectman-job-${runId}`,
      '--dir',
      incoming,
    ]);
    for (const output of CLOUD_IMAGE_JOB.outputs)
      await verifyAttestation(context, { repo, branch, run: id }, regularFile(path.join(incoming, output)));
    const image = await installBundle(context, { ref, out, incoming });
    report.step(
      'ok',
      'image',
      `source=${ref} platform=${image.platform} archiveSha256=${image.archiveSha256} imageId=${image.imageId} run=${url}`,
    );
  } catch (error) {
    fs.rmSync(out, { recursive: true, force: true });
    throw error;
  }
}
