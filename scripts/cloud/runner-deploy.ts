import fs from 'node:fs';
import path from 'node:path';
import { INSTANCE_NAME, REGION } from './config';
import type { DeployContext, HostContext } from './context';
import { badUsage, CloudError, refused } from './errors';
import { withHost } from './host';
import { locateGithubImage } from './image-github';
import { deployOnHost, reportedFailure } from './machine';
import type { DeployOutcome } from './machine';

/**
 * `runner-deploy` (PM-1197): the deploy that runs in the `projectman-deploy.yml` GitHub Actions job. The job holds an
 * AWS role that GitHub's OIDC issued (`configure-aws-credentials` put it into the environment), so there is no
 * profile, no `config.json` and no `cloud.env` here: everything comes from the flags, the image always comes from the
 * GitHub run of the commit, and the machine keeps the `cloud.env` it already has (checked, never sent).
 */

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface RunnerDeployInput {
  /** The commit to deploy: 40 hex digits, an ancestor of the default branch. */
  ref: string;
  /** `<owner>/<name>` of the GitHub repository the image was built in. */
  repository: string;
  region: string;
  /** The `Name` tag of the EC2 machine. */
  instance: string;
  /** The absolute path of the JSON report to write. */
  out: string;
}

/** What the job leaves for the devops: the deployed commit, the images and how it ended. */
interface RunnerDeployReport {
  commit: string;
  image: string | null;
  previous: string | null;
  healthy: boolean;
  rolledBack: boolean;
  finishedAt: string;
  /** The tags of the images that the cleanup removed after a healthy deploy. */
  pruned: string[];
}

function checkedInput(input: RunnerDeployInput): void {
  if (!SHA.test(input.ref)) throw badUsage('runner-deploy --ref needs a 40-digit commit id');
  if (!REPOSITORY.test(input.repository)) throw badUsage('runner-deploy --repository needs <owner>/<name>');
  if (!REGION.test(input.region))
    throw badUsage('runner-deploy --region needs an AWS region such as eu-west-1');
  if (!INSTANCE_NAME.test(input.instance))
    throw badUsage('runner-deploy --instance needs the name of the EC2 machine');
  if (!path.isAbsolute(input.out)) throw badUsage('runner-deploy --out needs an absolute path');
}

function writeReport(context: DeployContext, out: string, report: RunnerDeployReport): void {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
  context.report.step('ok', 'report', out);
}

/** The commit must be on the default branch of the repository (the checkout has the whole history). */
async function requireOnDefaultBranch(context: DeployContext, sha: string, branch: string): Promise<void> {
  const result = await context.deps.run(
    'git',
    ['-C', context.deps.repoRoot, 'merge-base', '--is-ancestor', sha, `origin/${branch}`],
    { env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 60_000 },
  );
  if (result.code === 1) throw refused(`${sha} is not on the default branch (${branch})`);
  if (result.code !== 0)
    throw new CloudError(
      `git merge-base failed: ${result.stderr.trim().split('\n').slice(-1)[0] ?? result.code}`,
    );
}

function reportOf(input: RunnerDeployInput, now: string, outcome?: DeployOutcome): RunnerDeployReport {
  return {
    commit: input.ref,
    image: outcome?.image.imageId ?? null,
    previous: outcome?.previousImageId ?? null,
    healthy: outcome?.healthy ?? false,
    rolledBack: outcome?.rolledBack ?? false,
    finishedAt: now,
    pruned: outcome?.pruned ?? [],
  };
}

export async function runRunnerDeploy(context: DeployContext, input: RunnerDeployInput): Promise<void> {
  checkedInput(input);
  const { report, deps } = context;
  const github = await report.guard('image', async () => {
    const found = await locateGithubImage(context, { sha: input.ref });
    if (found.run.repo !== input.repository)
      throw refused(`the image run belongs to ${found.run.repo}, not to ${input.repository}`);
    await requireOnDefaultBranch(context, input.ref, found.run.branch);
    report.step(
      'ok',
      'image',
      `source=${input.ref} artifact=${found.artifact.name} bytes=${found.artifact.bytes} run=${found.run.url}`,
    );
    return found;
  });
  const hostContext: HostContext = {
    deps,
    report,
    config: { aws: { ambient: true, region: input.region, instanceName: input.instance } },
  };
  const target = { sha: input.ref, ref: input.ref };
  let outcome: DeployOutcome;
  try {
    outcome = await withHost(hostContext, (host) =>
      deployOnHost(context, host, target, { kind: 'machine' }, { kind: 'github', github }),
    );
  } catch (error) {
    // The machine refused or the connection failed: the report still says that nothing healthy came of it.
    writeReport(context, input.out, reportOf(input, deps.now().toISOString()));
    throw error;
  }
  writeReport(context, input.out, reportOf(input, deps.now().toISOString(), outcome));
  if (!outcome.healthy) throw reportedFailure(`${input.ref} did not become healthy`);
}
