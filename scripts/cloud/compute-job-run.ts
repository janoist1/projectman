import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  COMPUTE_JOB_WORKFLOW,
  ComputeJobRunId,
  parseComputeJobRunTitle,
  type ComputeJobDefinition,
} from '@projectman/shared';
import type { CloudDeps } from './deps';
import { badUsage, CloudError, refused } from './errors';
import { githubRepoOf } from './github';
import { checked, noSymlinks } from './images';
import type { Report } from './report';

/**
 * Finds, follows and checks one run of a compute job on GitHub Actions (PM-1145, PM-1156): the part of
 * `image-fetch`, the cloud deploy and `engine-app fetch` that does not depend on which job it is. The job is a
 * parameter; the checks (workflow, event, default branch, result, title) and the attestation are the same.
 */

const POLL_MS = 15_000;
const MAX_WAIT_MS = 60 * 60 * 1000;
const WORKFLOW_PATH = `.github/workflows/${COMPUTE_JOB_WORKFLOW}`;

/** What the lookup needs of its environment: processes, the clock and the output report. */
export interface ComputeJobContext {
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

/** The `gh workflow run` line that starts the job on the default branch, for the owner to run. */
export function computeJobLaunchCommand(
  job: ComputeJobDefinition,
  repo: string,
  branch: string,
  ref: string,
  now: Date,
): string {
  const runId = `manual-${ref.slice(0, 8)}-${now.toISOString().replace(/\D/g, '').slice(0, 14)}`;
  const fields = [
    ['job', job.id],
    ['run_id', runId],
    ['commit', ref],
    ['runs_on', job.runsOn],
    ['node', job.node ?? ''],
    ['timeout_minutes', String(job.timeoutMinutes)],
    ['outputs', `'${job.outputs.join(' ')}'`],
    ['command', `'${job.command}'`],
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

async function readRun(context: ComputeJobContext, repo: string, id: number): Promise<Run> {
  const text = await checked(context, 'gh', ['api', `repos/${repo}/actions/runs/${id}`]);
  return parseJson(text, runSchema, `run ${id}`);
}

/** The newest run of the job at this commit, or null; GitHub's own list is the only source. */
async function findRun(
  context: ComputeJobContext,
  input: { repo: string; branch: string; ref: string; job: ComputeJobDefinition },
): Promise<number | null> {
  const text = await checked(context, 'gh', [
    'run',
    'list',
    '--repo',
    input.repo,
    '--workflow',
    COMPUTE_JOB_WORKFLOW,
    '--event',
    'workflow_dispatch',
    '--branch',
    input.branch,
    '--json',
    'databaseId,displayTitle,status,conclusion,createdAt',
    '--limit',
    '50',
  ]);
  const runs = parseJson(text, runListSchema, 'the run list')
    .filter((run) => {
      const title = parseComputeJobRunTitle(run.displayTitle);
      return title?.job === input.job.id && title.commit === input.ref;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return runs[0]?.databaseId ?? null;
}

/** Follows a run that is still going: every 15 seconds, for at most 60 minutes. */
async function finishedRun(context: ComputeJobContext, repo: string, id: number): Promise<Run> {
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

/** The run must be this workflow's, dispatched on the default branch, successful and about this job and commit. */
function checkOrigin(
  run: Run,
  input: { repo: string; branch: string; ref: string; job: ComputeJobDefinition },
): string {
  const url = runUrl(input.repo, run.id);
  const title = parseComputeJobRunTitle(run.display_title);
  if (run.path !== WORKFLOW_PATH) throw refused(`run ${url} is not a ${COMPUTE_JOB_WORKFLOW} run`);
  if (run.event !== 'workflow_dispatch') throw refused(`run ${url} was not started by hand`);
  if (run.head_branch !== input.branch)
    throw refused(`run ${url} did not run on the default branch ${input.branch}`);
  if (run.conclusion !== 'success')
    throw refused(`run ${url} did not succeed (${run.conclusion ?? 'no result'})`);
  if (title?.job !== input.job.id || title.commit !== input.ref)
    throw refused(`run ${url} is not the ${input.job.id} job of ${input.ref}`);
  return title.runId;
}

/** Both the exact workflow identity and this very run must have signed the file. */
export async function verifyAttestation(
  context: ComputeJobContext,
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

/** A downloaded output: a regular file with no symlink on its path. */
export function regularFile(file: string): string {
  noSymlinks(file);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile())
    throw refused(`${path.basename(file)} is missing from the downloaded run`);
  return file;
}

/** A checked, successful run of a compute job at one commit (what `image-fetch`, `deploy` and `engine-app fetch` start from). */
export interface ComputeJobRun {
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
 * Finds (or takes the given) run of `job` at `ref`, follows it until it ends and checks where it ran (workflow,
 * event, default branch, result, title). Never starts a run: it names the command that would.
 */
export async function locateComputeJobRun(
  context: ComputeJobContext,
  input: { root: string; ref: string; job: ComputeJobDefinition; run?: number },
): Promise<ComputeJobRun> {
  const { root, ref, job } = input;
  const repo = githubRepoOf(
    (await checked(context, 'git', ['-C', root, 'remote', 'get-url', 'origin'])).trim(),
  );
  const repository = parseJson(
    await checked(context, 'gh', ['api', `repos/${repo}`]),
    z.looseObject({ default_branch: z.string().min(1) }),
    `repository ${repo}`,
  );
  const branch = repository.default_branch;
  const id = input.run ?? (await findRun(context, { repo, branch, ref, job }));
  if (id === null)
    throw refused(
      `no ${COMPUTE_JOB_WORKFLOW} run of ${job.id} for ${ref}; start one with:\n` +
        computeJobLaunchCommand(job, repo, branch, ref, context.deps.now()),
    );
  const run = await finishedRun(context, repo, id);
  const runId = ComputeJobRunId.parse(checkOrigin(run, { repo, branch, ref, job }));
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
export async function computeJobArtifact(
  context: ComputeJobContext,
  run: ComputeJobRun,
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
  context: Pick<ComputeJobContext, 'report'> & { deps: Pick<CloudDeps, 'run' | 'pipe' | 'fetch'> },
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
