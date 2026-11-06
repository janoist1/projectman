import { z } from 'zod';
import { AwsCli, profileTarget } from './aws-cli';
import { sameJson } from './cloudflare-api';
import type { CloudContext } from './context';
import { CloudError, refused } from './errors';
import { readEc2HostInstance } from './ec2-host';
import { githubRepoOf } from './github';
import type { StepResult } from './report';

/**
 * `github-deploy-setup` (PM-1197): the one-off, idempotent setup that lets the `projectman-deploy.yml` GitHub Actions
 * job deploy the cloud board without an AWS key anywhere. It runs on the owner's computer with the central AWS
 * profile and the owner's `gh` login, and makes:
 *
 *  - AWS: the IAM OIDC provider of GitHub Actions and the role `projectman-cloud-deploy`, which only the `cloud-production`
 *    environment of this repository may assume (trust: `aud` + `sub`), for at most one hour, with an inline policy of
 *    exactly the SSM-calling rights of docs/AWS.md "EC2 host operation through SSM", scoped to the one machine;
 *  - GitHub: the `cloud-production` environment, limited to the default branch, with the variables the workflow reads
 *    (`PROJECTMAN_DEPLOY_ROLE_ARN`, `PROJECTMAN_AWS_REGION`, `PROJECTMAN_INSTANCE_NAME`). Variables, not secrets.
 *
 * It is a production change: the card only writes it, and the integrator runs it after the owner's yes.
 * `--dry-run` reads and changes nothing.
 */

export const DEPLOY_ROLE_NAME = 'projectman-cloud-deploy';
export const DEPLOY_ENVIRONMENT = 'cloud-production';
const PROVIDER_HOST = 'token.actions.githubusercontent.com';
const AUDIENCE = 'sts.amazonaws.com';
/** One hour: the longest the deploy may take (the workflow's role-duration-seconds). */
const MAX_SESSION_SECONDS = 3600;

const identitySchema = z.looseObject({ Account: z.string().regex(/^\d{12}$/) });
const providerSchema = z.looseObject({ ClientIDList: z.array(z.string()) });
const roleSchema = z.looseObject({
  Role: z.looseObject({
    MaxSessionDuration: z.number().optional(),
    AssumeRolePolicyDocument: z.unknown(),
  }),
});
const rolePolicySchema = z.looseObject({ PolicyDocument: z.unknown() });
const environmentSchema = z.looseObject({
  deployment_branch_policy: z
    .looseObject({ protected_branches: z.boolean(), custom_branch_policies: z.boolean() })
    .nullable()
    .optional(),
});
const branchPoliciesSchema = z.looseObject({
  branch_policies: z.array(z.looseObject({ id: z.number(), name: z.string() })),
});
const variableSchema = z.looseObject({ value: z.string() });
const defaultBranchSchema = z.looseObject({ default_branch: z.string().min(1) });

/** Only the environment of this repository, in the workflow's job, may assume the role. */
function trustPolicy(input: { account: string; repository: string }): unknown {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Federated: `arn:aws:iam::${input.account}:oidc-provider/${PROVIDER_HOST}` },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            [`${PROVIDER_HOST}:aud`]: AUDIENCE,
            [`${PROVIDER_HOST}:sub`]: `repo:${input.repository}:environment:${DEPLOY_ENVIRONMENT}`,
          },
        },
      },
    ],
  };
}

/**
 * The caller rights of docs/AWS.md "EC2 host operation through SSM" and nothing else: no IAM, no S3, no other machine.
 * The lookups that AWS cannot scope to a resource are `*`; they only read.
 */
function deployPolicy(input: { account: string; region: string; instanceId: string }): unknown {
  const instance = `arn:aws:ec2:${input.region}:${input.account}:instance/${input.instanceId}`;
  const document = (name: string) => `arn:aws:ssm:${input.region}::document/${name}`;
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'LookUp',
        Effect: 'Allow',
        Action: [
          'ec2:DescribeInstances',
          'ssm:DescribeInstanceInformation',
          'ssm:GetCommandInvocation',
          'ssm:DescribeSessions',
        ],
        Resource: '*',
      },
      {
        Sid: 'PublishTemporaryKey',
        Effect: 'Allow',
        Action: 'ec2-instance-connect:SendSSHPublicKey',
        Resource: instance,
        Condition: { StringEquals: { 'ec2:osuser': 'ubuntu' } },
      },
      {
        Sid: 'ReadHostKey',
        Effect: 'Allow',
        Action: 'ssm:SendCommand',
        Resource: [instance, document('AWS-RunShellScript')],
      },
      {
        Sid: 'SshThroughSsm',
        Effect: 'Allow',
        Action: 'ssm:StartSession',
        Resource: [instance, document('AWS-StartSSHSession')],
      },
      {
        // Data channel of the session this role started (docs: "Sample IAM policies for Session Manager").
        Sid: 'SshDataChannel',
        Effect: 'Allow',
        Action: 'ssmmessages:OpenDataChannel',
        Resource: 'arn:aws:ssm:*:*:session/${aws:userid}-*',
      },
      {
        // For an assumed role the session id is `<role id>:<session name>`, so the own-sessions rule is the AWS tag
        // condition, and only on sessions to this machine (docs: "Allow a user to end only sessions they started").
        Sid: 'CloseOwnSessions',
        Effect: 'Allow',
        Action: 'ssm:TerminateSession',
        Resource: '*',
        Condition: {
          StringLike: {
            'ssm:resourceTag/aws:ssmmessages:session-id': '${aws:userid}*',
            'ssm:resourceTag/aws:ssmmessages:target-id': input.instanceId,
          },
        },
      },
    ],
  };
}

interface GhAnswer {
  found: boolean;
  stdout: string;
}

/** `gh api`: a 404 is the answer "not there"; any other failure throws. A write sends its body on the standard input. */
async function gh(
  context: CloudContext,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  route: string,
  body?: unknown,
): Promise<GhAnswer> {
  const args = ['api', '--method', method, route, ...(body === undefined ? [] : ['--input', '-'])];
  const result = await context.deps.run('gh', args, {
    timeoutMs: 60_000,
    ...(body === undefined ? {} : { input: JSON.stringify(body) }),
  });
  if (result.code === 0) return { found: true, stdout: result.stdout };
  if (method === 'GET' && /HTTP 404/.test(result.stderr)) return { found: false, stdout: '' };
  throw new CloudError(`gh api ${method} ${route} failed (status ${result.code})`);
}

function ghJson<S extends z.ZodType>(answer: GhAnswer, schema: S, what: string): z.output<S> {
  try {
    return schema.parse(JSON.parse(answer.stdout));
  } catch {
    throw new CloudError(`${what} answered in an unexpected shape`);
  }
}

interface Plan {
  account: string;
  repository: string;
  branch: string;
  region: string;
  instanceName: string;
  roleArn: string;
  trust: unknown;
  policy: unknown;
}

async function awsSide(context: CloudContext, cli: AwsCli, plan: Plan, dryRun: boolean): Promise<void> {
  const { report } = context;
  const providerArn = `arn:aws:iam::${plan.account}:oidc-provider/${PROVIDER_HOST}`;

  await report.run('oidc-provider', async (): Promise<StepResult> => {
    const found = await cli.callAsOrNull(
      ['iam', 'get-open-id-connect-provider', '--open-id-connect-provider-arn', providerArn],
      ['NoSuchEntity'],
      providerSchema,
    );
    if (found) {
      if (!found.ClientIDList.includes(AUDIENCE))
        throw refused(`the OIDC provider ${PROVIDER_HOST} does not list the client id ${AUDIENCE}`);
      return { status: 'unchanged', detail: providerArn };
    }
    if (dryRun) return { status: 'skipped', detail: `dry-run: would create ${providerArn}` };
    await cli.call([
      'iam',
      'create-open-id-connect-provider',
      '--url',
      `https://${PROVIDER_HOST}`,
      '--client-id-list',
      AUDIENCE,
    ]);
    return { status: 'created', detail: providerArn };
  });

  await report.run('role', async (): Promise<StepResult> => {
    const found = await cli.callAsOrNull(
      ['iam', 'get-role', '--role-name', DEPLOY_ROLE_NAME],
      ['NoSuchEntity'],
      roleSchema,
    );
    if (!found) {
      if (dryRun) return { status: 'skipped', detail: `dry-run: would create ${plan.roleArn}` };
      await cli.call([
        'iam',
        'create-role',
        '--role-name',
        DEPLOY_ROLE_NAME,
        '--assume-role-policy-document',
        JSON.stringify(plan.trust),
        '--max-session-duration',
        String(MAX_SESSION_SECONDS),
        '--description',
        'GitHub Actions deploy of the projectman cloud board (PM-1197)',
      ]);
      return { status: 'created', detail: plan.roleArn };
    }
    // The maximum session cannot be shortened without another IAM right; a longer one is the owner's to look at.
    if (found.Role.MaxSessionDuration !== undefined && found.Role.MaxSessionDuration > MAX_SESSION_SECONDS)
      throw refused(
        `${DEPLOY_ROLE_NAME} allows sessions longer than ${MAX_SESSION_SECONDS} s; shorten it by hand`,
      );
    if (sameJson(found.Role.AssumeRolePolicyDocument, plan.trust))
      return { status: 'unchanged', detail: plan.roleArn };
    if (dryRun) return { status: 'skipped', detail: 'dry-run: would update the trust policy' };
    await cli.call([
      'iam',
      'update-assume-role-policy',
      '--role-name',
      DEPLOY_ROLE_NAME,
      '--policy-document',
      JSON.stringify(plan.trust),
    ]);
    return { status: 'updated', detail: 'trust policy' };
  });

  await report.run('role-policy', async (): Promise<StepResult> => {
    const found = await cli.callAsOrNull(
      ['iam', 'get-role-policy', '--role-name', DEPLOY_ROLE_NAME, '--policy-name', DEPLOY_ROLE_NAME],
      ['NoSuchEntity'],
      rolePolicySchema,
    );
    if (found && sameJson(found.PolicyDocument, plan.policy))
      return { status: 'unchanged', detail: DEPLOY_ROLE_NAME };
    if (dryRun)
      return { status: 'skipped', detail: `dry-run: would ${found ? 'update' : 'create'} the inline policy` };
    await cli.call([
      'iam',
      'put-role-policy',
      '--role-name',
      DEPLOY_ROLE_NAME,
      '--policy-name',
      DEPLOY_ROLE_NAME,
      '--policy-document',
      JSON.stringify(plan.policy),
    ]);
    return { status: found ? 'updated' : 'created', detail: `SSM rights of ${plan.instanceName} only` };
  });
}

async function githubSide(context: CloudContext, plan: Plan, dryRun: boolean): Promise<void> {
  const { report } = context;
  const base = `repos/${plan.repository}/environments/${DEPLOY_ENVIRONMENT}`;
  let environmentExists = false;

  await report.run('environment', async (): Promise<StepResult> => {
    const answer = await gh(context, 'GET', base);
    environmentExists = answer.found;
    const policy = answer.found
      ? ghJson(answer, environmentSchema, `environment ${DEPLOY_ENVIRONMENT}`).deployment_branch_policy
      : null;
    if (policy?.custom_branch_policies === true && policy.protected_branches === false)
      return { status: 'unchanged', detail: `${DEPLOY_ENVIRONMENT}, selected branches only` };
    if (dryRun) return { status: 'skipped', detail: `dry-run: would set up ${DEPLOY_ENVIRONMENT}` };
    await gh(context, 'PUT', base, {
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    });
    environmentExists = true;
    return { status: answer.found ? 'updated' : 'created', detail: DEPLOY_ENVIRONMENT };
  });

  await report.run('branch-policy', async (): Promise<StepResult> => {
    const listed = environmentExists
      ? ghJson(
          await gh(context, 'GET', `${base}/deployment-branch-policies`),
          branchPoliciesSchema,
          'branch policies',
        ).branch_policies
      : [];
    const others = listed.filter((policy) => policy.name !== plan.branch);
    const has = listed.some((policy) => policy.name === plan.branch);
    if (has && others.length === 0) return { status: 'unchanged', detail: plan.branch };
    if (dryRun)
      return { status: 'skipped', detail: `dry-run: would limit ${DEPLOY_ENVIRONMENT} to ${plan.branch}` };
    if (!has)
      await gh(context, 'POST', `${base}/deployment-branch-policies`, { name: plan.branch, type: 'branch' });
    for (const other of others) await gh(context, 'DELETE', `${base}/deployment-branch-policies/${other.id}`);
    return { status: 'updated', detail: plan.branch };
  });

  const variables: [string, string][] = [
    ['PROJECTMAN_DEPLOY_ROLE_ARN', plan.roleArn],
    ['PROJECTMAN_AWS_REGION', plan.region],
    ['PROJECTMAN_INSTANCE_NAME', plan.instanceName],
  ];
  for (const [name, value] of variables)
    await report.run(`variable ${name}`, async (): Promise<StepResult> => {
      const current = environmentExists ? await gh(context, 'GET', `${base}/variables/${name}`) : null;
      const existing = current?.found ? ghJson(current, variableSchema, `variable ${name}`).value : null;
      if (existing === value) return { status: 'unchanged', detail: value };
      if (dryRun)
        return {
          status: 'skipped',
          detail: `dry-run: would ${existing === null ? 'create' : 'update'} ${name}`,
        };
      if (existing === null) await gh(context, 'POST', `${base}/variables`, { name, value });
      else await gh(context, 'PATCH', `${base}/variables/${name}`, { name, value });
      return { status: existing === null ? 'created' : 'updated', detail: value };
    });
}

export async function runGithubDeploySetup(context: CloudContext, dryRun: boolean): Promise<void> {
  const { deps, config, report } = context;
  const cli = new AwsCli(deps, profileTarget(config.aws));
  const plan = await report.guard('plan', async (): Promise<Plan> => {
    const repository = githubRepoOf(config.repository.url);
    const { default_branch: branch } = ghJson(
      await gh(context, 'GET', `repos/${repository}`),
      defaultBranchSchema,
      `repository ${repository}`,
    );
    const { Account: account } = await cli.callAs(['sts', 'get-caller-identity'], identitySchema);
    const instance = await readEc2HostInstance(context);
    const region = config.aws.region;
    report.step(
      'ok',
      'plan',
      `${repository} (${branch}) -> account ${account}, ${region}, ${instance.InstanceId}`,
    );
    return {
      account,
      repository,
      branch,
      region,
      instanceName: config.aws.instanceName,
      roleArn: `arn:aws:iam::${account}:role/${DEPLOY_ROLE_NAME}`,
      trust: trustPolicy({ account, repository }),
      policy: deployPolicy({ account, region, instanceId: instance.InstanceId }),
    };
  });
  await awsSide(context, cli, plan, dryRun);
  await githubSide(context, plan, dryRun);
}
